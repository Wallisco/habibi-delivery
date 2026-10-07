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

import { registerPartnerAuth } from './auth.js';
import { OpsUsers, registerOpsAuth } from './opsAuth.js';
import { DriverTokens, registerDriverAuth } from './driverAuth.js';
import { markStaging } from './stagingBanner.js';
import { parseItems } from './items.js';
import { IdempotencyStore, idempotent } from './idempotency.js';
import { Simulator } from './simulator.js';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Db } from './db.js';
import { Metrics } from './metrics.js';
import { computeEarnings, costToServe } from './fees.js';
import { RateBook, RATE_FIELDS, MRD_DEFAULT, DAY_NAMES } from './rates.js';
import { routeJob, routingStatus, point } from './routing.js';
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

export function build({ logger = false, dbPath = process.env.DB_PATH ?? './data/dispatch.db',
  partnerAuth = true, partnerKeys = null, opsAuth = true, driverAuth = true, driverLegacyTokens,
  staging = process.env.DISPATCH_ENV === 'staging', simSpeed = 1 } = {}) {
  // Staging (habibi-staging.quikr.co.za) is where Keychat integrates: simulated
  // drivers, dispatchNow honoured, orders released within a minute, TEST badge.
  // Production ignores dispatchNow; the ready gate decides. Local runs and
  // tests (NODE_ENV not production) keep dispatchNow for convenience.
  const allowDispatchNow = staging || process.env.NODE_ENV !== 'production';
  // Caddy on the same box forwards the real client address. Trusting only
  // loopback means login throttling sees each person, not one shared 127.0.0.1.
  const app = Fastify({ logger, trustProxy: process.env.TRUST_PROXY ?? '127.0.0.1' });
  registerPartnerAuth(app, { enabled: partnerAuth, keys: partnerKeys });

  // dbPath ':memory:' gives an isolated database per instance, which is what
  // the tests want. Anything else is a file that survives a restart.
  const db = new Db(dbPath);
  // Staff logins for /ops and every /v1/ops/* route. Registered before any
  // route so nothing in the back office is reachable without a session.
  const opsUsers = new OpsUsers(db);
  registerOpsAuth(app, opsUsers, { enabled: opsAuth, staging });
  // Driver tokens for every /v1/driver/* route but sign-in (see driverAuth.js).
  const driverTokens = new DriverTokens(db);
  registerDriverAuth(app, driverTokens, {
    enabled: driverAuth,
    ...(driverLegacyTokens !== undefined ? { legacy: driverLegacyTokens } : {}),
  });
  const idem = new IdempotencyStore(db);
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
  // A driver is carrying a job in these states. OFFERED is not theirs yet.
  const ACTIVE = ['ASSIGNED', 'AT_STORE', 'IN_TRANSIT', 'AT_CUSTOMER'];

  // Restore state. Ready-gate history matters most: without it every store is
  // cold again after a restart and the gate falls back to a 25 minute prior.
  const restored = {
    drivers: supply.hydrate(db.loadDrivers()),
    jobs: jobs.hydrate(db.loadOpenJobs()),
    // Last five weeks of finished orders: driver pay weeks, statements and
    // the order list all need them after a restart.
    recentFinishedJobs: jobs.hydrate(db.loadRecentFinishedJobs(Date.now() - 35 * 86400000)),
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
  // Drivers come back OFFLINE with no active job (db.loadDrivers). Anyone still
  // holding an open job gets it back, so dispatch can't offer them a second
  // run while the first is in their box.
  for (const driverId of new Set(jobs.all().filter((j) => j.driverId && ACTIVE.includes(j.status)).map((j) => j.driverId))) {
    refreshDriverActive(driverId);
  }

  // Outbound queues. In production these are webhooks to Keychat and
  // FCM/APNs pushes to drivers.
  const pendingOffers = new Map();   // driverId -> offer
  const outbound = [];               // status events owed to Keychat

  const dispatcher = new Dispatcher({
    readyGate: gate, supply, jobs,
    maxHoldMs: staging ? 60_000 : null,
    onOffer: ({ batchId, jobs: batchJobs, carrying = [], driverId, expiresAt, stops, route,
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
        // On the run: this order joins the run the driver is already on.
        addsToRun: carrying.length > 0,
        summary: {
          orders: priced.length,
          runOrders: carrying.length + priced.length,
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
      // What is in the order, for the driver's checklist at the store.
      items: j.items ?? null,
      deliveryMode: j.deliveryMode, proofPolicy: j.proofPolicy,
      distanceKm: j.distanceKm,
      distanceSource: j.distanceSource ?? 'estimated',
      collectKm: j.collectKm,
      readyInMinutes: Math.max(0, Math.round(
        gate.predictPrepMinutes(j.storeId) - (Date.now() - j.createdAt) / 60000)),
    };
  }

  // Customer tracking link. Built on the token, never the job id.
  const trackingUrl = (job) => `${process.env.PUBLIC_URL ?? ''}/track/${job.trackingToken}`;

  /**
   * The customer's tracking link exists, as far as anyone outside ops is
   * concerned, only once the driver has collected the order.
   *
   * Before that there is nothing useful to watch -- the food is still in the
   * kitchen and the driver may yet be swapped -- and every extra message with a
   * live link in it is one more copy of a customer's address in the wild.
   * `delivery.collected` is the one event that hands it over; anything later
   * may repeat it, nothing earlier may carry it.
   */
  const isCollected = (job) => Boolean(job?.collectedAt);
  const linkIfCollected = (job) => (isCollected(job) ? { trackingUrl: trackingUrl(job) } : {});
  const TRACK_TTL_MIN = Number(process.env.TRACKING_LINK_TTL_MIN ?? 60);

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
    const { storeId, zone } = b;
    if (!b.pickup || !b.dropoff || !storeId) {
      return reply.code(400).send({ error: 'storeId, pickup and dropoff are required' });
    }
    // lat/lng or latitude/longitude, as documented; everything downstream
    // (routing, dispatch, tracking) works in lat/lng.
    const pickup = point(b.pickup), dropoff = point(b.dropoff);
    if (!pickup || !dropoff) {
      return reply.code(400).send({ error: 'pickup and dropoff need valid coordinates (lat/lng or latitude/longitude)' });
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

  // Idempotency-Key: a retried create returns the first response, not a
  // second job (see idempotency.js). Keychat should send its order id.
  app.post('/v1/keychat/jobs', idempotent(idem, 'jobs.create', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.storeId || !b.pickup || !b.dropoff) {
      return reply.code(400).send({ error: 'storeId, pickup and dropoff required' });
    }
    const pickupAt = point(b.pickup), dropoffAt = point(b.dropoff);
    if (!pickupAt || !dropoffAt) {
      return reply.code(400).send({ error: 'pickup and dropoff need valid coordinates (lat/lng or latitude/longitude)' });
    }
    b.pickup = { ...b.pickup, ...pickupAt };
    b.dropoff = { ...b.dropoff, ...dropoffAt };
    // What is in the order (optional, v1.2). Refused if it isn't a product list.
    const parsed = parseItems(b.items);
    if (parsed.error) return reply.code(400).send({ error: parsed.error });
    b.items = parsed.items;
    // We route it ourselves. Keychat's ETA is for their customer; our distance
    // is what the fee is built on, and it has to be defensible in a dispute.
    const routing = await routeJob({ pickup: b.pickup, dropoff: b.dropoff });
    // The partner does not choose our ids or tokens.
    const { id: _id, trackingToken: _t, ...input } = b;
    if (!allowDispatchNow) delete input.dispatchNow;
    const job = jobs.create({
      ...input,
      deliverKm: routing.deliverKm,
      collectKm: routing.collectKm,
    });
    job.distanceSource = routing.source;
    job.routing = routing;
    gate.noteOrder(job.storeId, job.createdAt);
    sim?.onJob(job);
    emit('delivery.accepted', {
      jobId: job.id, externalId: job.externalId, quoteId: job.quoteId,
      etaMinutes: Math.round(
        gate.predictPrepMinutes(job.storeId, job.merchantPrepMinutes) + routing.deliverMinutes + 4),
    });
    return reply.code(201).send({
      jobId: job.id, status: job.status,
      routing: { collectKm: routing.collectKm, deliverKm: routing.deliverKm, source: routing.source },
      dispatchAtMinutes: Number(gate.releaseOffsetMinutes(
        job.storeId, routing.collectMinutes, job.merchantPrepMinutes).toFixed(1)),
    });
  }));

  // The label print event. This is the ready-gate training signal and the
  // reason we can beat the incumbents' prep estimates.
  app.post('/v1/keychat/jobs/:id/ready', async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Unknown job' });
    // A POS that prints twice, or a retried call, must not count the same
    // prep time twice in the ready gate or send a second webhook.
    if (job.readyAt) {
      return { ok: true, duplicate: true, prepMinutes: Number(((job.readyAt - job.createdAt) / 60000).toFixed(1)) };
    }
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
      token: driverTokens.issue(account.driverId),
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

  /** The driver's offer, if it hasn't run out. An expired one is gone for good. */
  function liveOffer(driverId) {
    const o = pendingOffers.get(driverId);
    if (o && o.expiresAt <= Date.now()) { pendingOffers.delete(driverId); return null; }
    return o ?? null;
  }

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
      offer: liveOffer(req.params.id),
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

  /* ------------------------------------------ the driver's current job */

  /** Every job this driver is carrying right now, oldest first. */
  function driverRun(driverId) {
    return jobs.all()
      .filter((j) => j.driverId === driverId && ACTIVE.includes(j.status))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Point the driver's supply record at what they still carry. Called whenever
   * a job leaves them, by delivery or by the office, so they are freed exactly
   * when the box is empty and never left holding a closed job.
   */
  function refreshDriverActive(driverId) {
    const d = driverId ? supply.get(driverId) : null;
    if (!d) return;
    const run = driverRun(driverId);
    supply.upsert(driverId, run.length
      ? { activeJobId: run[0].id, activeBatchId: run[0].batchId ?? null }
      : { activeJobId: null, activeBatchId: null,
          state: d.state === SUPPLY.ROAMING_ACTIVE ? SUPPLY.RETURNING : d.state });
  }

  const stopView = (s) => ({ kind: s.kind, name: s.name, storeId: s.storeId ?? null,
    jobIds: s.jobIds, lat: s.at.lat, lng: s.at.lng });

  /**
   * Where the driver is in the run, counted the way the app counts: a single
   * order is [pickup, drop-off]; a run is its stop list.
   */
  function runPosition(run) {
    if (run.length === 1) return { stops: [], stopIndex: run[0].collectedAt ? 1 : 0 };
    const stops = routeStops(run).map(stopView);
    const byId = new Map(run.map((j) => [j.id, j]));
    const i = stops.findIndex((s) => (s.kind === 'PICKUP'
      ? s.jobIds.some((id) => !byId.get(id)?.collectedAt)
      : true));
    return { stops, stopIndex: Math.max(0, i) };
  }

  /**
   * Why a job the app still holds is no longer this driver's.
   *   CANCELLED   the order was cancelled
   *   CLOSED      the office closed it (failed, or marked delivered by hand)
   *   REASSIGNED  it went back to dispatch or to another driver
   *   CLEARED     the office cleared it from this driver ("Clear driver's job")
   *   DELIVERED   this driver delivered it: a normal finish, nothing to explain
   */
  function endedFor(jobId, driverId) {
    const job = jobs.get(jobId) ?? db.loadJob(jobId);
    if (!job) return { jobId, reason: 'CLOSED', at: null };
    // The last thing that happened to this job that names this driver; older
    // jobs without notes fall back to their last status change.
    const history = job.history ?? [];
    const last = [...history].reverse().find((h) => h.driverId === driverId) ?? history.at(-1) ?? {};
    const at = last.at ?? null;
    if (last.kind === 'CLEARED') return { jobId, reason: 'CLEARED', at };
    if (job.status === 'DELIVERED') {
      return { jobId, reason: last.kind === 'DRIVER' && job.driverId === driverId ? 'DELIVERED' : 'CLOSED', at };
    }
    if (job.status === 'CANCELLED') return { jobId, reason: 'CANCELLED', at };
    if (job.status === 'FAILED') return { jobId, reason: 'CLOSED', at };
    return { jobId, reason: 'REASSIGNED', at };
  }

  /**
   * The app asks every 10 seconds and on every screen change: what am I
   * carrying, and what happened to the jobs I think I have? This is what gets
   * a driver out of a job the office cancelled, closed or took away.
   */
  app.get('/v1/driver/current', async (req) => {
    const me = req.driverId;
    const run = driverRun(me);
    const held = String(req.query?.jobs ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
    const carrying = new Set(run.map((j) => j.id));
    return {
      jobs: run.map(publicJob),
      batchId: run[0]?.batchId ?? null,
      ...(run.length ? runPosition(run) : { stops: [], stopIndex: 0 }),
      stage: run[0] ? stageOf(run[0]) : null,
      ended: held.filter((id) => !carrying.has(id)).map((id) => endedFor(id, me)),
    };
  });

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
    // Every order this accept assigned (not the ones already on the run).
    for (const j of res.added ?? [res.job]) {
      emit('delivery.assigned', {
        jobId: j.id,
        externalId: j.externalId,
        driverId: req.body.driverId,
        driver: acct ? { firstName: acct.firstName || 'Your driver',
          vehicle: acct.vehicleType } : null,
        etaMinutes: j.routing?.deliverMinutes
          ? Math.round(j.routing.deliverMinutes + 6) : null,
      });
    }
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
  // A cancelled, closed or reassigned order is not the phone's to collect,
  // approach or complete -- even if the phone hasn't heard yet. 409 tells the
  // app (and its offline queue) to drop it rather than retry. (Which driver may
  // act on a live job needs auth on /v1/jobs/*, which is not here yet.)
  const isClosed = (job) => ['CANCELLED', 'FAILED', 'DELIVERED'].includes(job.status);
  const takenAway = (job) => !ACTIVE.includes(job.status)
    && (job.history ?? []).some((h) => h.kind === 'REASSIGNED' || h.kind === 'CLEARED');
  const notCarriable = (job) => isClosed(job) || takenAway(job);
  const notCarried = (job, reply) => reply.code(409).send({
    error: ['CANCELLED', 'FAILED', 'DELIVERED'].includes(job.status)
      ? `This order is ${job.status.toLowerCase()}.` : 'This order is no longer yours.',
    status: job.status,
  });

  app.post('/v1/jobs/:id/collect', async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Unknown job' });
    if (notCarriable(job)) return notCarried(job, reply);
    // A retried scan must not send the customer the link twice.
    if (job.collectedAt) return { ok: true, alreadyCollected: true };
    job.collectedAt = Date.now();
    jobs.setStatus(job.id, 'IN_TRANSIT');
    if (!job.readyAt) {
      // No print event from this merchant. Only usable if the courier waited.
      const waited = true;
      gate.observe(job.storeId, (job.collectedAt - job.createdAt) / 60000,
        { source: 'scan', courierWaited: waited });
    }
    // The only point at which the customer's tracking link is released.
    const acct = job.driverId ? accounts.get(job.driverId) : null;
    emit('delivery.collected', {
      jobId: job.id,
      externalId: job.externalId,
      trackingUrl: trackingUrl(job),
      driver: acct ? { firstName: acct.firstName || 'Your driver', vehicle: acct.vehicleType } : null,
      etaMinutes: job.routing?.deliverMinutes ? Math.round(job.routing.deliverMinutes) : null,
    });
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
    // Never send a code to the customer of a cancelled order.
    if (notCarriable(job)) return notCarried(job, reply);
    const code = otp.issue(job.id);
    job.codeIssuedAt = Date.now();
    jobs.setStatus(job.id, 'AT_CUSTOMER');
    emit('delivery.code_issued', {
      jobId: job.id, externalId: job.externalId, code,
      ...linkIfCollected(job),
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
    // A retried completion (offline queue, flaky signal) is not an error.
    if (job.status === 'DELIVERED' && job.proofGrade !== 'D') {
      return { accepted: true, duplicate: true, flagged: job.proofGrade === 'FLAGGED', earnings: job.earnings ?? null };
    }
    // Cancelled or closed while the phone was offline: it must not become delivered.
    if (notCarriable(job)) return notCarried(job, reply);

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
    jobs.setStatus(jobId, 'DELIVERED', {}, { driverId: job.driverId, by: 'driver', kind: 'DRIVER' });

    // A run is only finished when every drop on it is done. Freeing the
    // driver after the first would let dispatch offer them a new job while
    // they still have food in the box.
    refreshDriverActive(job.driverId);
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

  /**
   * Every job created since `from`, from the database (which has them all),
   * with the live in-memory copy laid over the top for anything in flight.
   * Back-office history reads this, never memory alone: memory is only what
   * has been loaded since the last restart.
   */
  const jobsSince = (from) => metrics.jobsSince(from).map((j) => jobs.get(j.id) ?? j);

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
    return buildStatement(jobsSince(Date.now() - days * 86400000), { from: Date.now() - days * 86400000, to: Date.now() });
  });

  // The same statement for the back office, behind staff login rather than
  // the partner key (the page has no business holding a partner key).
  app.get('/v1/ops/statement', async (req) => {
    const days = Number(req.query?.days ?? 7);
    return buildStatement(jobsSince(Date.now() - days * 86400000), { from: Date.now() - days * 86400000, to: Date.now() });
  });

  app.get('/v1/ops/integration', async (req) => {
    const type = req.query?.type ?? null;
    const all = db.recentOutbound(300);

    // Counts across everything, so a type with no recent rows still shows as a
    // tab rather than silently disappearing.
    const byType = {};
    for (const e of all) byType[e.type] = (byType[e.type] ?? 0) + 1;

    return {
      routing: routingStatus(),
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

    const inWindow = jobsSince(from);

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
          trackingToken: j.collectedAt ? j.trackingToken : null,
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
    // Older orders are not in memory after a restart; read them from disk.
    const j = jobs.get(req.params.jobId) ?? db.loadJob(req.params.jobId);
    if (!j) return reply.code(404).send({ error: 'Unknown order' });
    return {
      order: { ...j, trackingToken: isCollected(j) ? j.trackingToken : null },
      timeline: timeline(j),
      trackingUrl: isCollected(j) ? trackingUrl(j) : null,
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
      ...linkIfCollected(job),
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
  /** Close an order by hand (back office) or from the staging simulator. */
  function closeJob(job, { actor, reason, outcome, kind = 'OFFICE' }) {
    // Kept on the history entry, so the driver's app can say why it ended.
    const note = { driverId: job.driverId ?? null, by: actor, reason, kind };

    if (outcome === 'DELIVERED') {
      const waitMinutes = job.readyAt && job.collectedAt
        ? (job.collectedAt - job.readyAt) / 60000 : 0;
      job.completedAt = Date.now();
      job.proofGrade = 'D';
      job.earnings = priceJob(job, { waitMinutes });
      job.costToServe = costToServe(job.earnings);
      jobs.setStatus(job.id, 'DELIVERED', {}, note);
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
      jobs.setStatus(job.id, outcome, {}, note);
      emit('delivery.failed', { jobId: job.id, externalId: job.externalId, reason, actor });
    }

    // Free the driver either way, or they are stuck holding a closed job. In a
    // run they stay busy with the orders still in the box.
    refreshDriverActive(job.driverId);
  }

  /**
   * Take a job off its driver and put it back in the pool. The driver who had
   * it is never offered it again: whatever went wrong, someone else should go.
   */
  function requeueJob(job, { actor, reason, kind }) {
    const previous = job.driverId ?? null;
    dispatcher.offers.delete(job.id);
    if (previous) {
      const seen = dispatcher.declinedBy.get(job.id) ?? new Map();
      seen.set(previous, Infinity);
      dispatcher.declinedBy.set(job.id, seen);
    }
    jobs.setStatus(job.id, 'PENDING', { driverId: null, batchId: null },
      { driverId: previous, by: actor, reason, kind });
    refreshDriverActive(previous);
    // Staging: another simulated driver comes for it.
    sim?.onJob(job, { exclude: previous });
    return previous;
  }

  app.post('/v1/ops/orders/:jobId/close', async (req, reply) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return reply.code(404).send({ error: 'Unknown order' });
    if (['DELIVERED', 'FAILED', 'CANCELLED'].includes(job.status)) {
      return reply.code(409).send({ error: `Already ${job.status}` });
    }
    closeJob(job, { actor: req.body?.actor ?? 'ops', reason: req.body?.reason ?? 'Closed by the back office',
      outcome: req.body?.outcome ?? 'DELIVERED' });   // DELIVERED | FAILED | CANCELLED
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
      ...linkIfCollected(job),
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
    const previous = requeueJob(job, { actor: req.body?.actor ?? 'ops',
      reason: req.body?.reason ?? 'Reassigned by the back office', kind: 'REASSIGNED' });
    return { ok: true, status: 'PENDING', previousDriver: previous };
  });

  /* ------------------------------------------- back office: stuck drivers */

  const reasonOf = (req) => String(req.body?.reason ?? '').trim();

  /**
   * Sign a driver out of the app. Every token they hold stops working, so the
   * phone's next call (within 10 seconds) gets 401 and goes to sign-in. They
   * go offline so no offer is sent to a phone nobody is signed in on. A job
   * they are carrying stays theirs: clear it separately if it needs to move.
   */
  app.post('/v1/ops/drivers/:id/sign-out', async (req, reply) => {
    const id = req.params.id;
    if (!accounts.get(id)) return reply.code(404).send({ error: 'Unknown driver' });
    const reason = reasonOf(req);
    if (!reason) return reply.code(400).send({ error: 'Give a reason.' });
    const revoked = driverTokens.revokeAll(id);
    if (supply.get(id)) supply.upsert(id, { state: SUPPLY.OFFLINE });
    for (const [jobId, offer] of [...dispatcher.offers]) {
      if (offer.driverId === id) dispatcher.decline(jobId, id, { timedOut: true });
    }
    pendingOffers.delete(id);
    accounts.addNote(id, `Signed out by the office: ${reason}`, req.body?.actor ?? 'ops');
    return { ok: true, revoked, activeJobs: driverRun(id).map((j) => j.id) };
  });

  /**
   * Clear a driver's job: everything they are carrying. `requeue` sends the
   * orders back to dispatch for someone else (not once the food is collected:
   * it is in this driver's box). `close` ends them with an outcome. Either way
   * the driver is free, and their app returns to Home within 10 seconds.
   */
  app.post('/v1/ops/drivers/:id/clear-job', async (req, reply) => {
    const id = req.params.id;
    if (!accounts.get(id)) return reply.code(404).send({ error: 'Unknown driver' });
    const { action } = req.body ?? {};
    const outcome = req.body?.outcome ?? 'CANCELLED';
    const reason = reasonOf(req);
    if (!['requeue', 'close'].includes(action)) {
      return reply.code(400).send({ error: 'action must be requeue or close' });
    }
    if (action === 'close' && !['DELIVERED', 'FAILED', 'CANCELLED'].includes(outcome)) {
      return reply.code(400).send({ error: 'outcome must be DELIVERED, FAILED or CANCELLED' });
    }
    if (!reason) return reply.code(400).send({ error: 'Give a reason.' });
    const run = driverRun(id);
    if (!run.length) return reply.code(409).send({ error: 'This driver is not carrying a job.' });
    const actor = req.body?.actor ?? 'ops';
    if (action === 'requeue') {
      const collected = run.filter(isCollected).map((j) => j.id);
      if (collected.length) {
        return reply.code(409).send({ error: 'The food is already collected. Close the order instead.', collected });
      }
      for (const j of run) requeueJob(j, { actor, reason, kind: 'CLEARED' });
    } else {
      for (const j of run) closeJob(j, { actor, reason, outcome, kind: 'CLEARED' });
    }
    refreshDriverActive(id);
    return { ok: true, action, jobs: run.map((j) => j.id), ...(action === 'close' ? { outcome } : {}) };
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
    return markStaging(readFileSync(join(HERE, '..', 'public', 'ops.html'), 'utf8'), staging);
  });

  const HERE = dirname(fileURLToPath(import.meta.url));

  /* ------------------------------------------------- customer tracking */

  /**
   * Public, unauthenticated, keyed on an unguessable job id. Deliberately
   * shows the driver's first name and vehicle only -- never their surname,
   * phone or full location history.
   */
  app.get('/v1/track/:token', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex');
    const job = jobs.getByTrackingToken(req.params.token);
    // Before collection the link does not exist yet. Same 404 as a bad token,
    // so it reveals nothing about the order.
    if (!job || !isCollected(job)) return reply.code(404).send({ error: 'Not found' });

    // A finished order keeps its link for a short while ("was it delivered?"),
    // then the link dies. Nobody needs a customer's address on a link that
    // lives forever in a WhatsApp chat.
    const finished = ['DELIVERED', 'FAILED', 'CANCELLED'].includes(job.status);
    const endedAt = job.completedAt ?? job.failedAt ?? job.history?.at(-1)?.at ?? null;
    if (finished && endedAt && Date.now() - endedAt > TRACK_TTL_MIN * 60000) {
      return reply.code(410).send({ error: 'This tracking link has expired' });
    }
    const acct = job.driverId ? accounts.get(job.driverId) : null;
    const d = job.driverId ? supply.get(job.driverId) : null;
    return {
      ...(staging ? { test: true } : {}),
      status: job.status,
      label: ORDER_STATES.find((s) => s.code === job.status)?.label ?? job.status,
      pickup: { name: job.pickup?.name ?? null },
      dropoff: { name: job.dropoff?.name ?? null },
      driver: acct && !finished ? { firstName: acct.firstName || 'Your driver', vehicle: acct.vehicleType } : null,
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
      // The drop-off is the customer's home. Only while the order is live.
      dropoffPosition: finished ? null : {
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

  app.get('/track/:token', async (req, reply) => {
    reply.type('text/html');
    // The token is in the URL. Without this, every map tile request would hand
    // it to the tile server in the Referer header.
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex');
    return readFileSync(join(HERE, '..', 'public', 'track.html'), 'utf8');
  });

  app.get('/health', async () => ({ ok: true, env: staging ? 'staging' : 'production', routing: routingStatus().mode, uptime: process.uptime() }));
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

  const sim = staging ? new Simulator({ app, engine: { supply, jobs, accounts, pendingOffers, driverTokens }, closeJob, speed: simSpeed, log: app.log }) : null;

  app.decorate('engine', { opsUsers, driverTokens, idem, sim, gate, supply, jobs, dispatcher, otp, outbound, pendingOffers, db, metrics, rates, keychat, accounts, messages, ledger });
  return app;
}


if (process.argv[1]?.endsWith('server.js')) {
  const app = build({ logger: true });
  app.engine.dispatcher.start();
  app.engine.keychat.start();
  if (app.engine.sim) { app.engine.sim.start(); app.log.warn('STAGING: simulated drivers are running'); }

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
