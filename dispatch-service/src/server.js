/**
 * Dispatch service HTTP API.
 *
 * Two consumers:
 *   /v1/driver/*    the driver app
 *   /v1/keychat/*   Keychat: quote before checkout, job intake, POS ready events
 *
 * State is in-memory. The seams for Postgres (JobStore) and Redis
 * (SupplyRegistry) are single files; nothing else in the service touches
 * persistence directly.
 */

import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Db } from './db.js';
import { Metrics } from './metrics.js';
import { computeEarnings, costToServe } from './fees.js';
import { RateBook, RATE_FIELDS, MRD_DEFAULT, DAY_NAMES } from './rates.js';
import { routeJob, ROUTING_MODE } from './routing.js';
import { routeStops } from './batching.js';
import { KeychatClient, buildQuote, buildStatement } from './keychat.js';
import { DriverAccounts, ONBOARDING, REQUIRED_DOCS, HUBS, SHIFT_SLOTS,
  VEHICLE_TYPES, orderNumber } from './accounts.js';
import { ORDER_STATES, timeline, Messages, QUICK_REPLIES } from './orders.js';
import { Ledger, ENTRY, DAILY_ACCRUAL, WEEKLY_VEHICLE_FEE } from './ledger.js';
import { ReadyGate } from './readyGate.js';
import { SupplyRegistry, SUPPLY, travelMinutes, metresBetween } from './supply.js';
import { JobStore, PROOF_GRADE, GRADE_ORDER } from './jobs.js';
import { Dispatcher } from './dispatch.js';
import { OtpService } from './otp.js';

export function build({ logger = false, dbPath = process.env.DB_PATH ?? './data/dispatch.db' } = {}) {
  const app = Fastify({ logger });

  // dbPath ':memory:' gives an isolated database per instance, which is what
  // the tests want. Anything else is a file that survives a restart.
  const db = new Db(dbPath);
  const gate = new ReadyGate({ bufferMin: Number(process.env.READY_BUFFER_MIN ?? 0), db });
  const supply = new SupplyRegistry(db);
  const jobs = new JobStore(db);
  const otp = new OtpService();
  const metrics = new Metrics(db);
  const rates = new RateBook(db);
  const keychat = new KeychatClient(db, { log: app.log });
  const accounts = new DriverAccounts(db);
  const messages = new Messages(db);
  const ledger = new Ledger(db);
  const CUSTOMER_DELIVERY_FEE = Number(process.env.CUSTOMER_DELIVERY_FEE ?? 40);

  // Restore state. Ready-gate history matters most: without it every store is
  // cold again after a restart and the gate falls back to a 25 minute prior.
  const restored = {
    drivers: supply.hydrate(db.loadDrivers()),
    jobs: jobs.hydrate(db.loadOpenJobs()),
    prepSamples: 0,
  };
  restored.rateCards = rates.hydrate(db.loadRateCards());
  restored.surgeWindows = rates.hydrateSurge(db.loadSurge());
  restored.accounts = accounts.hydrate(db.loadAccounts());
  restored.messages = messages.hydrate(db.loadMessages());
  restored.ledgerEntries = ledger.hydrate(db.loadLedger());
  for (const s of db.loadPrepSamples()) {
    gate.observe(s.storeId, s.prepMinutes, { source: s.source, persist: false });
    restored.prepSamples += 1;
  }

  // Outbound queues. In production these are webhooks to Keychat and
  // FCM/APNs pushes to drivers.
  const pendingOffers = new Map();   // driverId -> offer
  const outbound = [];               // status events owed to Keychat

  const dispatcher = new Dispatcher({
    readyGate: gate, supply, jobs,
    onOffer: ({ batchId, jobs: batchJobs, driverId, expiresAt, stops, route,
                marginal, storeCount, sameCustomer }) => {
      const margin = new Map((marginal ?? []).map((m) => [m.jobId, m.marginalKm]));
      const priced = batchJobs.map((j, i) => ({
        ...publicJob(j),
        // The first order carries the full trip; the rest are priced on what
        // they add. A driver seeing three full fares would be misled.
        earningsPreview: priceJob(j, {
          stacked: i > 0,
          newStore: i > 0 && j.storeId !== batchJobs[0].storeId,
          batchSize: batchJobs.length,
          marginalKm: margin.get(j.id) ?? 0,
        }),
      }));

      const total = priced.reduce((a, j) => a + (j.earningsPreview?.total ?? 0), 0);

      pendingOffers.set(driverId, {
        batchId,
        jobId: batchJobs[0].id,
        expiresAt,
        job: priced[0],
        jobs: priced,
        stops: (stops ?? []).map((s) => ({
          kind: s.kind, name: s.name, storeId: s.storeId ?? null,
          jobIds: s.jobIds, lat: s.at.lat, lng: s.at.lng,
        })),
        summary: {
          orders: priced.length,
          stores: storeCount ?? 1,
          sameCustomer: Boolean(sameCustomer),
          km: route?.km ?? null,
          minutes: route?.total ?? null,
          totalEarnings: Number(total.toFixed(2)),
        },
      });
    },
  });

  // Always send a human-readable label. Keychat may post bare coordinates,
  // and the driver app renders these directly.
  const labelled = (p, fallback) => (p ? { ...p, name: p.name ?? fallback } : null);

  /**
   * Price a job. Called at quote time, at offer time and at completion, so the
   * number a driver is shown before accepting is the number they are paid --
   * the single most important property of a pay model a driver will trust.
   */
  function priceJob(j, { waitMinutes = 0, at = new Date() } = {}) {
    const zone = j.zone;
    const ratio = supply.supplyRatio(zone, jobs.pendingInZone(zone).length);
    const surge = rates.activeSurge(zone, at);
    return computeEarnings(j, rates.forZone(zone), {
      collectKm: j.collectKm ?? 0,
      deliverKm: j.distanceKm ?? 0,
      waitMinutes,
      supplyRatio: ratio,
      premiumMultiplier: rates.premiumMultiplier(zone, ratio),
      surgeBonus: surge.bonusRands,
      surgeLabels: surge.windows.map((w) => w.label),
      // The customer commits a tip at checkout, so this is not an estimate.
      tip: j.tip ?? 0,
    });
  }

  function publicJob(j) {
    return {
      id: j.id,
      // The number a driver reads out to support, and the one printed on the
      // bag. Without it they cannot say which job they are talking about.
      orderNumber: j.orderNumber,
      kind: j.kind, vertical: j.vertical, status: j.status,
      pickup: labelled(j.pickup, j.storeId ?? 'Collection point'),
      dropoff: labelled(j.dropoff, 'Delivery address'),
      storeId: j.storeId, ageRestricted: j.ageRestricted ?? false,
      // What the driver will actually be paid, tip included, computed now.
      earningsPreview: priceJob(j),
      tip: j.tip ?? 0,
      bagCount: j.bagCount, itemCount: j.itemCount, fee: j.fee,
      deliveryMode: j.deliveryMode, proofPolicy: j.proofPolicy,
      distanceKm: j.distanceKm,
      distanceSource: j.distanceSource ?? 'estimated',
      collectKm: j.collectKm,
      readyInMinutes: Math.max(0, Math.round(
        gate.predictPrepMinutes(j.storeId) - (Date.now() - j.createdAt) / 60000)),
    };
  }

  function emit(type, payload) {
    const e = keychat.emit(type, payload);
    outbound.push({ type, at: e.at, payload });
    if (outbound.length > 500) outbound.shift();
    return e;
  }

  /* ------------------------------------------------------------- keychat */

  // Synchronous. Keychat needs a price and ETA to show inside a WhatsApp
  // conversation before the customer pays, so this must stay fast and must
  // reflect current supply rather than promising something we will miss.
  /**
   * Price an order before the customer pays.
   *
   * Keychat sends the addresses and the merchant's prep estimate. We route it,
   * price it, and hand back both what they should charge the customer and what
   * the delivery will cost us, itemised. They add the delivery fee to the order
   * total; we hold the quote for reconciliation.
   */
  app.post('/v1/keychat/quote', async (req, reply) => {
    const b = req.body ?? {};
    const { storeId, zone, pickup, dropoff } = b;
    if (!pickup || !dropoff || !storeId) {
      return reply.code(400).send({ error: 'storeId, pickup and dropoff are required' });
    }

    const routing = await routeJob({ pickup, dropoff });
    const merchantPrep = b.prepMinutes != null ? Number(b.prepMinutes) : null;

    const prep = gate.predictPrepMinutes(storeId, merchantPrep);
    const ratio = supply.supplyRatio(zone, jobs.pendingInZone(zone).length);
    const strain = ratio < 1 ? 1.25 : ratio < 1.5 ? 1.1 : 1.0;
    const surge = rates.activeSurge(zone);

    const draft = {
      id: 'quote', zone, bagCount: b.bagCount ?? 1,
      distanceKm: routing.deliverKm, collectKm: routing.collectKm,
    };
    const earnings = computeEarnings(draft, rates.forZone(zone), {
      collectKm: routing.collectKm,
      deliverKm: routing.deliverKm,
      waitMinutes: 0,
      supplyRatio: ratio,
      premiumMultiplier: rates.premiumMultiplier(zone, ratio),
      surgeBonus: surge.bonusRands,
      surgeLabels: surge.windows.map((w) => w.label),
      tip: Number(b.tip ?? 0),
    });

    const quoteId = `Q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    return buildQuote({
      quoteId,
      job: draft,
      earnings,
      routing,
      etaMinutes: Math.round((prep + routing.deliverMinutes + 4) * strain),
      customerCharge: CUSTOMER_DELIVERY_FEE,
      readyGate: {
        merchantPrepMinutes: merchantPrep,
        predictedPrepMinutes: Number(prep.toFixed(1)),
        confidence: gate.confidence(storeId, merchantPrep),
        releaseOffsetMinutes: Number(
          gate.releaseOffsetMinutes(storeId, routing.collectMinutes, merchantPrep).toFixed(1)),
      },
    });
  });

  app.post('/v1/keychat/jobs', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.storeId || !b.pickup || !b.dropoff) {
      return reply.code(400).send({ error: 'storeId, pickup and dropoff required' });
    }
    // We route it ourselves. Keychat's ETA is for their customer; our distance
    // is what the fee is built on, and it has to be defensible in a dispute.
    const routing = await routeJob({ pickup: b.pickup, dropoff: b.dropoff });
    const job = jobs.create({
      ...b,
      deliverKm: routing.deliverKm,
      collectKm: routing.collectKm,
    });
    job.distanceSource = routing.source;
    job.routing = routing;
    gate.noteOrder(job.storeId, job.createdAt);
    emit('delivery.accepted', {
      jobId: job.id, externalId: job.externalId, quoteId: job.quoteId,
      trackingUrl: `${process.env.PUBLIC_URL ?? ''}/track/${job.id}`,
      etaMinutes: Math.round(
        gate.predictPrepMinutes(job.storeId, job.merchantPrepMinutes) + routing.deliverMinutes + 4),
    });
    return reply.code(201).send({
      jobId: job.id, status: job.status,
      routing: { collectKm: routing.collectKm, deliverKm: routing.deliverKm, source: routing.source },
      dispatchAtMinutes: Number(gate.releaseOffsetMinutes(
        job.storeId, routing.collectMinutes, job.merchantPrepMinutes).toFixed(1)),
    });
  });

  // The label print event. This is the ready-gate training signal and the
  // reason we can beat the incumbents' prep estimates.
  app.post('/v1/keychat/jobs/:id/ready', async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Unknown job' });
    jobs.markReady(job.id);
    gate.observe(job.storeId, (job.readyAt - job.createdAt) / 60000, { source: 'print' });
    emit('delivery.merchant_ready', { jobId: job.id });
    return { ok: true, prepMinutes: Number(((job.readyAt - job.createdAt) / 60000).toFixed(1)) };
  });

  app.get('/v1/keychat/events', async () => ({ events: outbound.slice(-100) }));

  /* -------------------------------------------------------------- driver */

  app.post('/v1/driver/signin', async (req, reply) => {
    const phone = String(req.body?.phone ?? '').replace(/\s/g, '');
    if (phone.replace(/\D/g, '').length < 9) {
      return reply.code(400).send({ error: 'A valid phone number is required' });
    }
    const account = accounts.register({
      phone,
      firstName: req.body?.firstName ?? '',
      lastName: req.body?.lastName ?? '',
      hubCode: req.body?.hubCode ?? 'TYG',
    });
    supply.upsert(account.driverId, { phone, zone: account.zone });
    return {
      token: `tok_${account.driverId}`,
      driver: {
        id: account.driverId, phone, hubCode: account.hubCode, zone: account.zone,
        onboarding: account.onboarding, vehicleType: account.vehicleType,
        // The app shows an onboarding checklist until this is true.
        canWork: account.onboarding === ONBOARDING.ACTIVE,
      },
    };
  });

  app.get('/v1/driver/:id/account', async (req, reply) => {
    const a = accounts.get(req.params.id);
    if (!a) return reply.code(404).send({ error: 'Unknown driver' });
    return {
      ...a,
      requiredDocs: REQUIRED_DOCS,
      canWork: a.onboarding === ONBOARDING.ACTIVE,
      outstanding: Object.entries(a.documents)
        .filter(([, d]) => d.status !== 'VERIFIED')
        .map(([k]) => REQUIRED_DOCS.find((r) => r.key === k)?.label ?? k),
    };
  });

  /* ------------------------------------------------------------ messaging */

  app.get('/v1/driver/:id/messages', async (req) => ({
    messages: messages.thread(req.params.id),
    unread: messages.unreadFor(req.params.id).length,
  }));

  app.post('/v1/driver/:id/messages', async (req) =>
    messages.send({ driverId: req.params.id, from: 'driver',
      body: req.body?.body ?? '', jobId: req.body?.jobId ?? null }));

  app.post('/v1/driver/:id/messages/read', async (req) =>
    ({ marked: messages.markRead(req.params.id, req.body?.upToId ?? null) }));

  app.post('/v1/driver/:id/state', async (req, reply) => {
    const { state, zone } = req.body ?? {};
    if (state !== SUPPLY.OFFLINE && !accounts.isDispatchable(req.params.id)) {
      const a = accounts.get(req.params.id);
      return reply.code(403).send({
        error: 'Your account is not active yet',
        onboarding: a?.onboarding ?? 'UNKNOWN',
        outstanding: a ? Object.entries(a.documents)
          .filter(([, d]) => d.status !== 'VERIFIED').map(([k]) => k) : [],
      });
    }
    if (!Object.values(SUPPLY).includes(state)) {
      return reply.code(400).send({ error: 'Unknown supply state' });
    }
    const d = supply.get(req.params.id);
    if (d?.activeJobId && state === SUPPLY.OFFLINE) {
      return reply.code(409).send({ error: 'Finish your current delivery first' });
    }
    return supply.upsert(req.params.id, { state, ...(zone ? { zone } : {}) });
  });

  app.post('/v1/driver/:id/position', async (req) => {
    const { lat, lng } = req.body ?? {};
    supply.upsert(req.params.id, { position: { lat, lng } });
    return { ok: true };
  });

  app.get('/v1/driver/:id/shift', async (req) => {
    const d = supply.get(req.params.id) ?? {};
    const pending = jobs.pendingInZone(d.zone).length;
    const ratio = supply.supplyRatio(d.zone, pending);
    // Restore the whole run. Returning only the anchor job would lose the
    // other stops on any reload, mid-delivery.
    const activeSet = d.activeBatchId
      ? jobs.all().filter((j) => j.batchId === d.activeBatchId
          && !['DELIVERED', 'FAILED', 'CANCELLED'].includes(j.status))
      : (d.activeJobId ? [jobs.get(d.activeJobId)].filter(Boolean) : []);
    const active = activeSet[0] ?? null;
    return {
      state: d.state ?? SUPPLY.OFFLINE,
      zone: d.zone ?? null,
      supplyRatio: Number(ratio.toFixed(2)),
      roamingPremium: supply.roamingPremium(ratio),
      offer: pendingOffers.get(req.params.id) ?? null,
      // The server is the source of truth for what the driver is carrying.
      // The app rehydrates from this after any reload.
      activeJob: active ? publicJob(active) : null,
      activeJobs: activeSet.map(publicJob),
      activeBatchId: d.activeBatchId ?? null,
      activeStops: activeSet.length > 1
        ? routeStops(activeSet).map((s) => ({
            kind: s.kind, name: s.name, storeId: s.storeId ?? null,
            jobIds: s.jobIds, lat: s.at.lat, lng: s.at.lng,
          }))
        : [],
      activeStage: active ? stageOf(active) : null,
    };
  });

  /** Derive the delivery stage from the job's own timestamps. */
  function stageOf(j) {
    if (j.status === 'DELIVERED') return 'DONE';
    if (j.collectedAt) return 'NAVIGATE_CUSTOMER';
    if (j.readyAt || j.status === 'ASSIGNED') return 'NAVIGATE_STORE';
    return 'NAVIGATE_STORE';
  }

  // Job history. A driver must be able to see what they are on and what they
  // have done -- for their own pay reconciliation as much as anything.
  app.get('/v1/driver/:id/jobs', async (req) => {
    const mine = jobs.all()
      .filter((j) => j.driverId === req.params.id)
      .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt));
    return {
      active: mine.filter((j) => j.status !== 'DELIVERED').map(publicJob),
      completed: mine.filter((j) => j.status === 'DELIVERED').slice(0, 50).map((j) => ({
        ...publicJob(j),
        completedAt: j.completedAt,
        proofGrade: j.proofGrade,
        earnings: j.earnings ?? null,
        waitAtStoreMinutes: j.readyAt && j.collectedAt
          ? Number(((j.collectedAt - j.readyAt) / 60000).toFixed(1)) : null,
      })),
    };
  });

  app.post('/v1/jobs/:id/accept', async (req, reply) => {
    const res = dispatcher.accept(req.params.id, req.body?.driverId);
    if (!res.ok) return reply.code(409).send({ error: res.reason });
    pendingOffers.delete(req.body.driverId);
    const acct = accounts.get(req.body.driverId);
    emit('delivery.assigned', {
      jobId: req.params.id,
      externalId: res.job.externalId,
      driverId: req.body.driverId,
      // Send this now. The customer should be able to watch the driver
      // approach, not discover where they are once they have arrived.
      trackingUrl: `${process.env.PUBLIC_URL ?? ''}/track/${req.params.id}`,
      driver: acct ? { firstName: acct.firstName || 'Your driver',
        vehicle: acct.vehicleType } : null,
      etaMinutes: res.job.routing?.deliverMinutes
        ? Math.round(res.job.routing.deliverMinutes + 6) : null,
    });
    return {
      ok: true,
      job: publicJob(res.job),
      jobs: (res.jobs ?? [res.job]).map(publicJob),
      batchId: res.batchId ?? null,
      stops: (res.stops ?? []).map((s) => ({
        kind: s.kind, name: s.name, storeId: s.storeId ?? null,
        jobIds: s.jobIds, lat: s.at.lat, lng: s.at.lng,
      })),
    };
  });

  app.post('/v1/jobs/:id/decline', async (req) => {
    dispatcher.decline(req.params.id, req.body?.driverId);
    pendingOffers.delete(req.body?.driverId);
    return { ok: true };
  });

  // The driver's collection scan. Separate event from the label print: print
  // time is when the food was ready, scan time is when it was collected, and
  // the gap between them is the wait we are trying to remove.
  app.post('/v1/jobs/:id/collect', async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Unknown job' });
    job.collectedAt = Date.now();
    jobs.setStatus(job.id, 'IN_TRANSIT');
    if (!job.readyAt) {
      // No print event from this merchant. Only usable if the courier waited.
      const waited = true;
      gate.observe(job.storeId, (job.collectedAt - job.createdAt) / 60000,
        { source: 'scan', courierWaited: waited });
    }
    emit('delivery.collected', { jobId: job.id });
    return {
      ok: true,
      waitAtStoreMinutes: job.readyAt
        ? Number(((job.collectedAt - job.readyAt) / 60000).toFixed(1)) : null,
    };
  });

  // Issued on approach. The response deliberately does not contain the code.
  app.post('/v1/jobs/:id/approach', async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Unknown job' });
    const code = otp.issue(job.id);
    job.codeIssuedAt = Date.now();
    jobs.setStatus(job.id, 'AT_CUSTOMER');
    emit('delivery.code_issued', {
      jobId: job.id, externalId: job.externalId, code,
      // The customer's live tracking link, handed to Keychat to show in chat.
      trackingUrl: `${process.env.PUBLIC_URL ?? ''}/track/${job.id}`,
    });   // -> Keychat -> WhatsApp
    return { ok: true, codeSentToCustomer: true };
  });

  app.post('/v1/jobs/:id/verify', async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Unknown job' });
    const { code, position } = req.body ?? {};
    const res = otp.verify(job.id, code, { position, job });
    if (!res.verified) return reply.code(422).send(res);
    return { verified: true };
  });

  app.post('/v1/jobs/complete', async (req, reply) => {
    const { jobId, grade, position, gpsTrail, code } = req.body ?? {};
    const job = jobs.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Unknown job' });

    if (GRADE_ORDER[grade] < GRADE_ORDER[job.proofPolicy.minGrade]) {
      return reply.code(422).send({
        accepted: false,
        error: `This delivery needs at least grade ${job.proofPolicy.minGrade} proof`,
      });
    }

    // Re-verify offline completions. A GPS trail that never entered the
    // geofence is caught here every time.
    let flagged = false;
    if (grade === PROOF_GRADE.B) {
      const entered = (gpsTrail ?? []).some(
        (p) => metresBetween(p, job.dropoff) <= job.proofPolicy.geofenceMetres);
      if (!entered) flagged = true;
    }

    job.completedAt = Date.now();
    job.proofGrade = flagged ? 'FLAGGED' : grade;

    // Itemise the pay now, while we still have the wait and supply context.
    const waitMinutes = job.readyAt && job.collectedAt
      ? (job.collectedAt - job.readyAt) / 60000 : 0;
    const pending = jobs.pendingInZone(job.zone).length;
    if (req.body?.tip != null) job.tip = Number(req.body.tip);
    job.earnings = priceJob(job, { waitMinutes });
    job.costToServe = costToServe(job.earnings);
    jobs.setStatus(jobId, 'DELIVERED');

    const d = supply.get(job.driverId);
    if (d) {
      // A run is only finished when every drop on it is done. Freeing the
      // driver after the first would let dispatch offer them a new job while
      // they still have food in the box.
      const remaining = job.batchId
        ? jobs.all().filter((j) => j.batchId === job.batchId
            && !['DELIVERED', 'FAILED', 'CANCELLED'].includes(j.status))
        : [];
      supply.upsert(job.driverId, {
        activeJobId: remaining[0]?.id ?? null,
        activeBatchId: remaining.length ? job.batchId : null,
        state: remaining.length ? d.state
          : (d.state === SUPPLY.ROAMING_ACTIVE ? SUPPLY.RETURNING : d.state),
      });
    }
    const payoutHeld = grade === PROOF_GRADE.B || flagged;
    db.saveEvidence({
      jobId, grade, flagged, payoutHeld,
      bundle: { position, gpsTrail, code: code ? 'redacted' : null },
    });
    if (job.driverId) ledger.accrueDay(job.driverId);

    emit('delivery.delivered', {
      jobId, externalId: job.externalId, grade: job.proofGrade, flagged,
      completedAt: job.completedAt,
      // The final itemised charge, so Keychat can close the order and reconcile.
      charge: {
        customerCharge: job.customerCharge,
        driverCost: job.earnings.platformFunded,
        tipPassedThrough: job.earnings.tip,
        margin: job.customerCharge != null
          ? Number((job.customerCharge - job.earnings.platformFunded).toFixed(2)) : null,
        lines: job.earnings.lines,
      },
    });
    return { accepted: true, flagged, payoutHeld, earnings: job.earnings };
  });

  const TIP_MEAN = 17.13;   // measured: Mr D TYG hub, 78,891 legs
  app.get('/v1/driver/:id/earnings', async (req) => {
    const mine = jobs.all().filter(
      (j) => j.driverId === req.params.id && j.status === 'DELIVERED');
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const weekAgo = Date.now() - 7 * 86400000;

    const sum = (list) => ({
      orders: list.length,
      delivery: Math.round(list.reduce(
        (a, j) => a + (j.earnings?.platformFunded ?? j.fee), 0)),
      tips: Math.round(list.reduce(
        (a, j) => a + (j.earnings?.tip ?? TIP_MEAN), 0)),
      waitMinutes: Math.round(list.reduce(
        (a, j) => a + (j.earnings?.waitMinutes ?? 0), 0)),
    });

    const week = sum(mine.filter((j) => j.completedAt >= weekAgo));
    const bal = ledger.balance(req.params.id);
    const wtd = ledger.weekToDate(req.params.id);

    return {
      today: sum(mine.filter((j) => j.completedAt >= startOfDay.getTime())),
      week: { ...week, vehicleFee: wtd.charged },
      // The vehicle account, in the driver's own terms: what accrued, what
      // they have paid, what is still owing.
      vehicle: {
        dailyRate: DAILY_ACCRUAL,
        weeklyRate: WEEKLY_VEHICLE_FEE,
        thisWeek: wtd,
        owing: bal.owing,
        paid: bal.paid,
        accrued: bal.accrued,
        daysBehind: bal.daysBehind,
      },
    };
  });

  app.get('/v1/driver/:id/statement', async (req) => {
    const days = Number(req.query?.days ?? 30);
    return ledger.statement(req.params.id, { from: Date.now() - days * 86400000 });
  });

  /* ---------------------------------------------------------------- ops */

  /* -------------------------------------------------------- back office */

  const since = (req) => {
    const days = Number(req.query?.days ?? 7);
    return Date.now() - days * 24 * 3600 * 1000;
  };

  app.get('/v1/ops/rates', async () => ({
    fields: RATE_FIELDS,
    mrdDefault: MRD_DEFAULT,
    zones: [...new Set([...rates.zones(),
      ...jobs.all().map((j) => j.zone).filter(Boolean)])]
      .map((z) => ({ zone: z, card: rates.forZone(z), custom: rates.zones().includes(z) })),
  }));

  app.put('/v1/ops/rates/:zone', async (req, reply) => {
    const card = rates.setZone(req.params.zone, req.body?.card, req.body?.actor ?? 'ops');
    return { zone: req.params.zone, card };
  });

  app.post('/v1/ops/rates/:zone/reset', async (req) =>
    ({ zone: req.params.zone, card: rates.resetZone(req.params.zone) }));

  app.get('/v1/ops/rates/:zone/history', async (req) =>
    ({ zone: req.params.zone, history: db.rateHistory(req.params.zone) }));

  /** What a driver would earn on a given job right now, before it happens. */
  app.post('/v1/ops/rates/:zone/preview', async (req) => {
    const zone = req.params.zone;
    const b = req.body ?? {};
    const ratio = Number(b.supplyRatio ?? supply.supplyRatio(zone, jobs.pendingInZone(zone).length));
    return computeEarnings(
      { id: 'preview', zone, bagCount: b.bagCount ?? 1, distanceKm: b.deliverKm ?? 3.6 },
      rates.forZone(zone),
      { collectKm: b.collectKm ?? 0.9, deliverKm: b.deliverKm ?? 3.6,
        waitMinutes: b.waitMinutes ?? 0, supplyRatio: ratio,
        premiumMultiplier: rates.premiumMultiplier(zone, ratio), tip: b.tip ?? 0 });
  });

  app.get('/v1/keychat/statement', async (req) => {
    const days = Number(req.query?.days ?? 7);
    return buildStatement(jobs.all(), { from: Date.now() - days * 86400000, to: Date.now() });
  });

  app.get('/v1/ops/integration', async (req) => {
    const type = req.query?.type ?? null;
    const all = db.recentOutbound(300);

    // Counts across everything, so a type with no recent rows still shows as a
    // tab rather than silently disappearing.
    const byType = {};
    for (const e of all) byType[e.type] = (byType[e.type] ?? 0) + 1;

    return {
      routing: { mode: ROUTING_MODE, osrmConfigured: ROUTING_MODE === 'osrm' },
      webhook: { configured: keychat.configured, queued: keychat.queue.length },
      events: db.outboundStats(),
      types: byType,
      selected: type,
      recent: (type && type !== 'ALL' ? all.filter((e) => e.type === type) : all).slice(0, 60),
    };
  });

  /* -------------------------------------------- back office: drivers */

  app.get('/v1/ops/accounts', async () => ({
    hubs: HUBS, shiftSlots: SHIFT_SLOTS, vehicleTypes: VEHICLE_TYPES,
    requiredDocs: REQUIRED_DOCS, states: Object.values(ONBOARDING),
    pipeline: accounts.pipeline(),
    drivers: accounts.all().map((a) => {
      const live = supply.get(a.driverId);
      return {
        driverId: a.driverId,
        name: `${a.firstName} ${a.lastName}`.trim() || a.phone,
        phone: a.phone,
        hubCode: a.hubCode,
        zone: a.zone,
        vehicleType: a.vehicleType,
        vehicleReg: a.vehicleReg,
        shiftSlot: a.shiftSlot,
        onboarding: a.onboarding,
        docsVerified: Object.values(a.documents).filter((d) => d.status === 'VERIFIED').length,
        docsTotal: REQUIRED_DOCS.length,
        liveState: live?.state ?? 'OFFLINE',
        activeJobId: live?.activeJobId ?? null,
        acceptanceRate: live?.acceptanceRate ?? 1,
        unread: messages.unreadFor(a.driverId).length,
      };
    }),
  }));

  app.get('/v1/ops/accounts/:id', async (req, reply) => {
    const a = accounts.get(req.params.id);
    if (!a) return reply.code(404).send({ error: 'Unknown driver' });
    const mine = jobs.all().filter((j) => j.driverId === a.driverId);
    return {
      account: a,
      requiredDocs: REQUIRED_DOCS,
      live: supply.get(a.driverId) ?? null,
      thread: messages.thread(a.driverId, 50),
      recentJobs: mine.slice(-20).reverse().map((j) => ({
        jobId: j.id, orderNumber: j.orderNumber, status: j.status,
        storeId: j.storeId, completedAt: j.completedAt,
        earned: j.earnings?.total ?? null,
      })),
    };
  });

  app.patch('/v1/ops/accounts/:id', async (req, reply) => {
    const a = accounts.update(req.params.id, req.body ?? {}, req.body?.actor ?? 'ops');
    return a ? a : reply.code(404).send({ error: 'Unknown driver' });
  });

  app.post('/v1/ops/accounts/:id/document', async (req, reply) => {
    const a = accounts.setDocument(req.params.id, req.body?.docKey, req.body?.status,
      { note: req.body?.note, actor: req.body?.actor ?? 'ops' });
    return a ? a : reply.code(400).send({ error: 'Unknown driver or document' });
  });

  app.post('/v1/ops/accounts/:id/onboarding', async (req, reply) => {
    const r = accounts.setOnboarding(req.params.id, req.body?.state,
      { actor: req.body?.actor ?? 'ops', reason: req.body?.reason });
    if (!r) return reply.code(404).send({ error: 'Unknown driver' });
    if (r.error) return reply.code(409).send(r);
    return r;
  });

  app.post('/v1/ops/accounts/:id/note', async (req) =>
    accounts.addNote(req.params.id, req.body?.text ?? '', req.body?.actor ?? 'ops'));

  /* ------------------------------------------- back office: messaging */

  app.get('/v1/ops/messages', async () =>
    ({ inbox: messages.inbox(), quickReplies: QUICK_REPLIES }));

  app.get('/v1/ops/messages/:driverId', async (req) =>
    ({ driverId: req.params.driverId, thread: messages.thread(req.params.driverId) }));

  app.post('/v1/ops/messages/:driverId', async (req) =>
    messages.send({ driverId: req.params.driverId, from: 'ops',
      body: req.body?.body ?? '', jobId: req.body?.jobId ?? null,
      actor: req.body?.actor ?? 'ops' }));

  /* ---------------------------------------------- back office: orders */

  app.get('/v1/ops/orders', async (req) => {
    const days = Number(req.query?.days ?? 7);
    const from = Date.now() - days * 86400000;
    const status = req.query?.status ?? null;
    const q = String(req.query?.q ?? '').trim().toLowerCase();

    const inWindow = jobs.all().filter((j) => j.createdAt >= from);

    /**
     * Match on anything an operator would have in front of them: the order
     * number a customer read out, a partial ending, the store, the address,
     * the driver. Substring rather than prefix, because people quote the last
     * five digits far more often than the first.
     */
    const matches = (j) => {
      if (!q) return true;
      return [j.orderNumber, j.externalId, j.id, j.storeId, j.driverId,
        j.pickup?.name, j.dropoff?.name, j.zone]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
    };

    const searched = inWindow.filter(matches);

    // Counts are of the searched set, not the filtered one, so the tab badges
    // stay meaningful while a search is active.
    const counts = { ALL: searched.length };
    for (const st of ORDER_STATES) {
      counts[st.code] = searched.filter((j) => j.status === st.code).length;
    }

    return {
      states: ORDER_STATES,
      counts,
      query: q || null,
      orders: searched
        .filter((j) => !status || status === 'ALL' || j.status === status)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 300)
        .map((j) => ({
          jobId: j.id,
          orderNumber: j.orderNumber,
          externalId: j.externalId,
          status: j.status,
          statusLabel: ORDER_STATES.find((s) => s.code === j.status)?.label ?? j.status,
          storeId: j.storeId,
          zone: j.zone,
          pickupName: j.pickup?.name ?? j.storeId,
          dropoffName: j.dropoff?.name ?? 'Address not supplied',
          dropoff: j.dropoff ?? null,
          pickup: j.pickup ?? null,
          driverId: j.driverId,
          createdAt: j.createdAt,
          completedAt: j.completedAt,
          deliverKm: j.distanceKm,
          customerCharge: j.customerCharge,
          driverCost: j.earnings?.platformFunded ?? null,
          tip: j.earnings?.tip ?? j.tip ?? 0,
          waitAtStoreMin: j.readyAt && j.collectedAt
            ? Number(((j.collectedAt - j.readyAt) / 60000).toFixed(1)) : null,
          // An agent taking a "the driver is at my door" call should see the
          // code without drilling into the order.
          deliveryCode: otp.peek(j.id)?.code ?? null,
          proofGrade: j.proofGrade,
          ageMinutes: Number(((Date.now() - j.createdAt) / 60000).toFixed(0)),
        })),
    };
  });

  app.get('/v1/ops/orders/:jobId', async (req, reply) => {
    const j = jobs.get(req.params.jobId);
    if (!j) return reply.code(404).send({ error: 'Unknown order' });
    return {
      order: j,
      timeline: timeline(j),
      trackingUrl: `${process.env.PUBLIC_URL ?? ''}/track/${j.id}`,
      driver: j.driverId ? accounts.get(j.driverId) : null,
      // The customer's code, for an agent on the phone to someone who cannot
      // find it. Ops-only: it appears in no driver-facing response.
      deliveryCode: otp.peek(j.id),
      canIssueCode: !!j.driverId && !['DELIVERED','FAILED','CANCELLED'].includes(j.status),
      canClose: !['DELIVERED','FAILED','CANCELLED'].includes(j.status),
    };
  });

  /**
   * Issue the customer's code from the back office.
   *
   * Normally the driver's "I have arrived" triggers this. An agent needs the
   * same ability for the case where the driver's app cannot reach us, or the
   * geofence is misbehaving, and the customer is standing there waiting.
   */
  app.post('/v1/ops/orders/:jobId/issue-code', async (req, reply) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return reply.code(404).send({ error: 'Unknown order' });
    const code = otp.issue(job.id);
    if (!job.codeIssuedAt) {
      job.codeIssuedAt = Date.now();
      jobs.setStatus(job.id, 'AT_CUSTOMER');
    }
    emit('delivery.code_issued', {
      jobId: job.id, externalId: job.externalId, code,
      trackingUrl: `${process.env.PUBLIC_URL ?? ''}/track/${job.id}`,
      issuedBy: req.body?.actor ?? 'ops',
    });
    return { ok: true, code };
  });

  /**
   * Close a job by hand.
   *
   * Grade D: an agent override, recorded as such. Every one of these is a
   * delivery that could not close on its own, so they are counted per driver
   * and a rate well above their peers is a fraud signal rather than bad luck.
   */
  app.post('/v1/ops/orders/:jobId/close', async (req, reply) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return reply.code(404).send({ error: 'Unknown order' });
    if (['DELIVERED', 'FAILED', 'CANCELLED'].includes(job.status)) {
      return reply.code(409).send({ error: `Already ${job.status}` });
    }
    const actor = req.body?.actor ?? 'ops';
    const reason = req.body?.reason ?? 'Closed by the back office';
    const outcome = req.body?.outcome ?? 'DELIVERED';   // DELIVERED | FAILED | CANCELLED

    if (outcome === 'DELIVERED') {
      const waitMinutes = job.readyAt && job.collectedAt
        ? (job.collectedAt - job.readyAt) / 60000 : 0;
      job.completedAt = Date.now();
      job.proofGrade = 'D';
      job.earnings = priceJob(job, { waitMinutes });
      job.costToServe = costToServe(job.earnings);
      jobs.setStatus(job.id, 'DELIVERED');
      db.saveEvidence({ jobId: job.id, grade: 'D', flagged: false, payoutHeld: false,
        bundle: { override: true, actor, reason } });
      emit('delivery.delivered', {
        jobId: job.id, externalId: job.externalId, grade: 'D', flagged: false,
        completedAt: job.completedAt,
        charge: {
          customerCharge: job.customerCharge,
          driverCost: job.earnings.platformFunded,
          tipPassedThrough: job.earnings.tip,
          margin: job.customerCharge != null
            ? Number((job.customerCharge - job.earnings.platformFunded).toFixed(2)) : null,
          lines: job.earnings.lines,
        },
      });
    } else {
      job.failedAt = Date.now();
      job.failReason = reason;
      jobs.setStatus(job.id, outcome);
      emit('delivery.failed', { jobId: job.id, externalId: job.externalId, reason, actor });
    }

    // Free the driver either way, or they are stuck holding a closed job.
    if (job.driverId) {
      const d = supply.get(job.driverId);
      if (d?.activeJobId === job.id) {
        supply.upsert(job.driverId, {
          activeJobId: null,
          state: d.state === SUPPLY.ROAMING_ACTIVE ? SUPPLY.RETURNING : d.state,
        });
      }
    }
    return { ok: true, status: job.status, grade: job.proofGrade ?? null };
  });

  /**
   * Correct a delivery address.
   *
   * Customers give wrong addresses, and an agent on the phone needs to fix it
   * without cancelling and re-creating the order. Re-routes and re-prices,
   * because moving the drop-off moves the distance the driver is paid for.
   *
   * Refused once delivered: the fee has been settled and Keychat has been
   * billed, so a change at that point is a dispute, not an edit.
   */
  app.patch('/v1/ops/orders/:jobId/address', async (req, reply) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return reply.code(404).send({ error: 'Unknown order' });
    if (['DELIVERED', 'FAILED', 'CANCELLED'].includes(job.status)) {
      return reply.code(409).send({ error: `Cannot change the address of a ${job.status} order` });
    }

    const b = req.body ?? {};
    const lat = Number(b.lat ?? b.latitude);
    const lng = Number(b.lng ?? b.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return reply.code(400).send({ error: 'lat and lng are required' });
    }

    const before = { name: job.dropoff?.name, km: job.distanceKm };
    job.dropoff = { lat, lng, name: b.name ?? job.dropoff?.name ?? 'Delivery address' };

    const routing = await routeJob({ pickup: job.pickup, dropoff: job.dropoff });
    job.distanceKm = routing.deliverKm;
    job.distanceSource = routing.source;
    job.routing = routing;

    // A moved drop-off invalidates the code: it was issued against the old
    // geofence, and verification is bound to position.
    const reissued = otp.peek(job.id) ? otp.issue(job.id) : null;

    job.history.push({ at: Date.now(), from: job.status, to: job.status,
      note: `Address changed from "${before.name}" (${before.km} km) to "${job.dropoff.name}" (${routing.deliverKm} km) by ${b.actor ?? 'ops'}` });
    jobs.setStatus(job.id, job.status);

    emit('delivery.address_changed', {
      jobId: job.id, externalId: job.externalId,
      dropoff: job.dropoff, deliverKm: routing.deliverKm,
      trackingUrl: `${process.env.PUBLIC_URL ?? ''}/track/${job.id}`,
    });

    return {
      ok: true,
      dropoff: job.dropoff,
      deliverKm: routing.deliverKm,
      distanceSource: routing.source,
      codeReissued: Boolean(reissued),
      note: reissued
        ? 'The delivery code was reissued because the geofence moved.'
        : null,
    };
  });

  /** Put a stuck job back in the pool for another driver. */
  app.post('/v1/ops/orders/:jobId/reassign', async (req, reply) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return reply.code(404).send({ error: 'Unknown order' });
    const previous = job.driverId;
    if (previous) {
      const d = supply.get(previous);
      if (d?.activeJobId === job.id) supply.upsert(previous, { activeJobId: null });
    }
    dispatcher.offers.delete(job.id);
    // Do not re-offer to the driver who could not complete it.
    if (previous) {
      const seen = dispatcher.declinedBy.get(job.id) ?? new Set();
      seen.add(previous);
      dispatcher.declinedBy.set(job.id, seen);
    }
    jobs.setStatus(job.id, 'PENDING', { driverId: null });
    return { ok: true, status: 'PENDING', previousDriver: previous };
  });

  /* ------------------------------------------- back office: vehicle ledger */

  app.get('/v1/ops/ledger', async () => ({
    dailyRate: DAILY_ACCRUAL,
    weeklyRate: WEEKLY_VEHICLE_FEE,
    balances: ledger.allBalances(accounts.all().map((a) => a.driverId))
      .map((b) => {
        const a = accounts.get(b.driverId);
        return { ...b, name: a ? `${a.firstName} ${a.lastName}`.trim() || a.phone : b.driverId,
          hubCode: a?.hubCode ?? null };
      }),
  }));

  app.get('/v1/ops/ledger/:driverId', async (req) => {
    const days = Number(req.query?.days ?? 90);
    return {
      balance: ledger.balance(req.params.driverId),
      statement: ledger.statement(req.params.driverId,
        { from: Date.now() - days * 86400000 }),
    };
  });

  app.post('/v1/ops/ledger/:driverId/entry', async (req, reply) => {
    const b = req.body ?? {};
    if (!Object.values(ENTRY).includes(b.type)) {
      return reply.code(400).send({ error: 'type must be PAYMENT, DEDUCTION or ADJUSTMENT' });
    }
    // Money in is negative, so a payment reduces what is owed.
    const amount = ['PAYMENT', 'DEDUCTION'].includes(b.type)
      ? -Math.abs(Number(b.amount)) : Number(b.amount);
    return ledger.add({ driverId: req.params.driverId, type: b.type, amount,
      note: b.note ?? null, ref: b.ref ?? null, actor: b.actor ?? 'ops' });
  });

  /**
   * Import settlements exported from Xero.
   *
   * Xero is the record of what a driver actually paid; we only accrue. Matched
   * on reference so re-importing the same file cannot double-credit anyone.
   */
  app.post('/v1/ops/ledger/import', async (req) =>
    ledger.importPayments(req.body?.payments, { actor: req.body?.actor ?? 'xero' }));

  /**
   * Why pending orders did or did not group. A dispatcher that silently
   * declines to stack is impossible to trust; this makes the reason legible.
   */
  app.get('/v1/ops/batching', async () => ({
    pairs: dispatcher.explainBatching(),
    batches: dispatcher.formBatches().filter((b) => b.length > 1).map((b) => ({
      orders: b.map((j) => j.orderNumber ?? j.id),
      stores: [...new Set(b.map((j) => j.storeId))],
      stops: routeStops(b).length,
    })),
    rules: {
      maxBatch: 3,
      pickupClusterM: 500,
      dropoffClusterM: 500,
      maxReadySpreadMin: 10,
      maxAddedLatenessMin: 6,
    },
  }));

  app.get('/v1/ops/surge', async () => ({
    days: DAY_NAMES,
    zones: [...new Set([...rates.surgeByZone.keys(),
      ...jobs.all().map((j) => j.zone).filter(Boolean)])]
      .map((z) => ({
        zone: z,
        windows: rates.surgeFor(z),
        custom: rates.surgeByZone.has(z),
        activeNow: rates.activeSurge(z),
        forecast: rates.surgeForecast(z),
      })),
    defaultWindows: rates.defaultSurge,
  }));

  app.put('/v1/ops/surge/:zone', async (req) =>
    ({ zone: req.params.zone,
       windows: rates.setSurge(req.params.zone, req.body?.windows, req.body?.actor ?? 'ops') }));

  app.get('/v1/ops/summary', async (req) => metrics.summary(since(req)));
  app.get('/v1/ops/merchants', async (req) => ({ stores: metrics.merchants(since(req)) }));
  app.get('/v1/ops/drivers', async (req) => ({ drivers: metrics.drivers(since(req)) }));
  app.get('/v1/ops/exceptions', async (req) => ({ exceptions: metrics.exceptions(since(req)) }));
  app.get('/v1/ops/hourly', async (req) => ({ hours: metrics.hourly(since(req)) }));

  /** Everything the console needs in one round trip. */
  app.get('/v1/ops/dashboard', async (req) => {
    const s = since(req);
    return {
      summary: metrics.summary(s),
      merchants: metrics.merchants(s).slice(0, 12),
      drivers: metrics.drivers(s).slice(0, 20),
      exceptions: metrics.exceptions(s).slice(0, 30),
      hourly: metrics.hourly(s),
      live: {
        driversOnline: supply.available().length,
        jobsPending: jobs.pending().length,
        openOffers: dispatcher.offers.size,
        // Live supply ratio and the premium it is currently driving, per zone.
        zones: [...new Set(jobs.all().map((j) => j.zone).filter(Boolean))].map((z) => {
          const ratio = supply.supplyRatio(z, jobs.pendingInZone(z).length);
          return {
            zone: z,
            supplyRatio: Number(ratio.toFixed(2)),
            premiumMultiplier: rates.premiumMultiplier(z, ratio),
            premiumRands: Number((rates.forZone(z).premiumFee
              * rates.premiumMultiplier(z, ratio)).toFixed(2)),
          };
        }),
      },
    };
  });

  app.get('/ops', async (req, reply) => {
    reply.type('text/html');
    return readFileSync(join(HERE, '..', 'public', 'ops.html'), 'utf8');
  });

  const HERE = dirname(fileURLToPath(import.meta.url));

  /* ------------------------------------------------- customer tracking */

  /**
   * Public, unauthenticated, keyed on an unguessable job id. Deliberately
   * shows the driver's first name and vehicle only -- never their surname,
   * phone or full location history.
   */
  app.get('/v1/track/:jobId', async (req, reply) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return reply.code(404).send({ error: 'Not found' });
    const acct = job.driverId ? accounts.get(job.driverId) : null;
    const d = job.driverId ? supply.get(job.driverId) : null;
    return {
      jobId: job.id,
      status: job.status,
      label: ORDER_STATES.find((s) => s.code === job.status)?.label ?? job.status,
      pickup: { name: job.pickup?.name ?? null },
      dropoff: { name: job.dropoff?.name ?? null },
      driver: acct ? { firstName: acct.firstName || 'Your driver', vehicle: acct.vehicleType } : null,
      // Live position, only while the delivery is in flight. Once it is
      // delivered the driver's whereabouts are none of the customer's business.
      driverPosition: d?.position && !['DELIVERED', 'FAILED', 'CANCELLED'].includes(job.status)
        ? { lat: d.position.lat, lng: d.position.lng,
            // How stale the fix is. A map showing a driver frozen in a tunnel
            // is worse than a map that admits it has lost them.
            secondsAgo: Math.round((Date.now() - (d.lastSeen ?? 0)) / 1000) }
        : null,
      pickupPosition: ['ASSIGNED', 'AT_STORE'].includes(job.status)
        ? { lat: job.pickup.lat ?? job.pickup.latitude,
            lng: job.pickup.lng ?? job.pickup.longitude } : null,
      dropoffPosition: {
        lat: job.dropoff.lat ?? job.dropoff.latitude,
        lng: job.dropoff.lng ?? job.dropoff.longitude },
      etaMinutes: d?.position && ['IN_TRANSIT', 'AT_CUSTOMER'].includes(job.status)
        ? Math.max(1, Math.round(travelMinutes(d.position, {
            lat: job.dropoff.lat ?? job.dropoff.latitude,
            lng: job.dropoff.lng ?? job.dropoff.longitude }))) : null,
      timeline: timeline(job).map(({ code, label, at, meta }) => ({ code, label, at, meta })),
    };
  });

  // Vendored assets. Serving Leaflet ourselves removes a CDN dependency that
  // can be blocked by a corporate network, an ad blocker or a CSP -- and when
  // it is blocked the map is simply blank, with nothing to explain why.
  const MIME = { '.js': 'application/javascript', '.css': 'text/css',
    '.png': 'image/png', '.svg': 'image/svg+xml' };
  app.get('/vendor/*', async (req, reply) => {
    const rel = req.params['*'].replace(/\.\./g, '');
    const ext = rel.slice(rel.lastIndexOf('.'));
    try {
      const body = readFileSync(join(HERE, '..', 'public', 'vendor', rel));
      reply.type(MIME[ext] ?? 'application/octet-stream');
      reply.header('cache-control', 'public, max-age=604800');
      return body;
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
  });

  app.get('/track/:jobId', async (req, reply) => {
    reply.type('text/html');
    return readFileSync(join(HERE, '..', 'public', 'track.html'), 'utf8');
  });

  app.get('/health', async () => ({ ok: true, uptime: process.uptime() }));
  app.get('/v1/ops/stats', async () => ({
    readyGate: gate.snapshot(),
    jobs: {
      total: jobs.all().length,
      pending: jobs.pending().length,
      delivered: jobs.all().filter((j) => j.status === 'DELIVERED').length,
    },
    drivers: {
      online: supply.available().length,
      total: supply.drivers.size,
    },
    openOffers: dispatcher.offers.size,
    persistence: db.stats(),
    restoredOnBoot: restored,
  }));

  app.decorate('engine', { gate, supply, jobs, dispatcher, otp, outbound, pendingOffers, db, metrics, rates, keychat, accounts, messages, ledger });
  return app;
}


if (process.argv[1]?.endsWith('server.js')) {
  const app = build({ logger: true });
  app.engine.dispatcher.start();
  app.engine.keychat.start();

  // Close the database cleanly so WAL is checkpointed rather than left behind.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      app.log.info('shutting down, closing database');
      app.engine.dispatcher.stop();
      try { app.engine.db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
  }
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: '0.0.0.0' })
    .then(() => app.log.info(`dispatch service on :${port}`))
    .catch((e) => { app.log.error(e); process.exit(1); });
}
