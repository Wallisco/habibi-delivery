/**
 * Dispatch engine.
 *
 * Runs a short batching window rather than assigning each job on arrival.
 * Greedy instant assignment is locally sensible and globally poor -- it burns
 * the closest driver on whichever job happened to arrive first.
 */

import { SUPPLY, metresBetween, travelMinutes } from './supply.js';
import { canJoin, routeStops, routeMinutes, marginalDistances, storeCount,
  isSameCustomer, MAX_BATCH, planRun, planStamp, readyAt } from './batching.js';
import { warmLegsInBackground, TABLE_MAX_POINTS, legMinutes } from './routing.js';

// A driver is carrying a job in these states.
const ACTIVE = ['ASSIGNED', 'AT_STORE', 'IN_TRANSIT', 'AT_CUSTOMER'];

export const TICK_MS = 3000;              // batching window
// How long a driver has to accept an offer (plus 5 s per extra order on a run).
export const OFFER_TIMEOUT_MS = 45_000;
export const BASE_RADIUS_M = 6000;
export const RADIUS_GROWTH_PER_MIN = 900;  // widen as a job ages
export const MAX_RADIUS_M = 15000;

/** How long a driver is skipped for a job after a missed or refused offer. */
export const TIMEOUT_COOLDOWN_MS = 90_000;
export const DECLINE_COOLDOWN_MS = 10 * 60_000;

/**
 * Next job ("chaining"). A driver carrying ONE collected order can be offered
 * ONE next order, if they will finish their drop and reach the next store by
 * the time its food is ready. Their customer is not delayed at all, and the
 * next order needs no second driver standing at the counter. Single orders
 * only: never onto a stacked run, never a stacked next job.
 */
export const CHAIN = {
  doorMin: 5,       // time at the customer's door (the brief's "door time")
  maxWaitMin: 8,    // don't commit a driver to food further off than this
  handBackMin: 2,   // give the next job back once they'd reach the store this late
};

/** Cost weights. Tune against a replay, not by intuition. */
export const W = {
  pickupEta: 1.0,
  latenessRisk: 2.4,
  detour: 0.8,
  displacement: 1.6,
  equity: 0.35,
  acceptance: 0.5,
  batchSynergy: 12.0,
};

export class Dispatcher {
  constructor({ readyGate, supply, jobs, onOffer, now = () => Date.now(), maxHoldMs = null }) {
    // Staging only: release every order within this long, so an integration
    // test never waits on a 25-minute prep prior.
    this.maxHoldMs = maxHoldMs;
    this.gate = readyGate;
    this.supply = supply;
    this.jobs = jobs;
    this.onOffer = onOffer;
    this.now = now;
    this.offers = new Map();     // jobId -> { driverId, expiresAt }
    // Persists across offers for a job's lifetime. Without this, a decline is
    // forgotten on the next tick and the same driver gets the same job again,
    // forever.
    // jobId -> Map<driverId, expiresAt>
    //
    // Declines EXPIRE. Making them permanent was correct-looking and wrong:
    // with three drivers on a zone, a handful of offer timeouts left jobs that
    // no remaining driver was allowed to see, and they sat PENDING forever. A
    // driver who missed an offer because they were riding should get it again.
    this.declinedBy = new Map();
    // jobId -> { driverId, at }: offers that ran out, so accept can say so.
    this.expired = new Map();
    this.timer = null;
  }

  start() { if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS); }
  stop() { clearInterval(this.timer); this.timer = null; }

  /* ------------------------------------------------------------- eligibility */

  /**
   * The ready gate. A job is not eligible the moment it is placed -- it becomes
   * eligible at (predicted ready) minus (travel to the store) minus buffer.
   * Dispatch a food order too early and the driver stands in a restaurant for
   * eight minutes. This single rule does more for utilisation than any clever
   * matching.
   */
  isEligible(job, nowMs = this.now()) {
    if (job.status !== 'PENDING') return false;
    if (job.dispatchNow) return true;
    if (this.maxHoldMs != null && nowMs - job.createdAt >= this.maxHoldMs) return true;
    const ageMin = (nowMs - job.createdAt) / 60000;
    // Assume a typical nearby driver for the gate decision; the per-driver
    // travel time is applied again in the cost function.
    const typicalTravel = 4;
    return this.gate.isDispatchable(
      job.storeId, ageMin, typicalTravel, job.merchantPrepMinutes ?? null);
  }

  /** Slack drives urgency. Never hardcode "food beats parcel". */
  slackMinutes(job, nowMs = this.now()) {
    const estimatedDuration = 12 + travelMinutes(job.pickup, job.dropoff);
    return (job.promiseAt - nowMs) / 60000 - estimatedDuration;
  }

  searchRadius(job, nowMs = this.now()) {
    const ageMin = (nowMs - job.createdAt) / 60000;
    return Math.min(MAX_RADIUS_M, BASE_RADIUS_M + ageMin * RADIUS_GROWTH_PER_MIN);
  }

  /* ---------------------------------------------------------- hard filtering */

  candidates(job, nowMs = this.now()) {
    const radius = this.searchRadius(job, nowMs);

    // Drivers holding a job are normally out of the running. A driver standing
    // in the same kitchen waiting for the order they already have is the best
    // possible candidate for a second one from that kitchen.
    const stackers = [...this.supply.drivers.values()].filter((d) =>
      d.activeJobId && d.position && this.stackableWith(job, d));
    // One open offer per driver: a second would replace the first on their phone.
    const offered = new Set([...this.offers.values()].map((o) => o.driverId));

    return [...this.supply.available(), ...stackers].filter((d) => {
      if (offered.has(d.id)) return false;
      if (!this.supply.acceptsKind(d.state, job.kind)) return false;
      if (metresBetween(d.position, job.pickup) > radius) return false;
      if (job.requiredCapabilities?.some((c) => !d.capabilities.includes(c))) return false;
      if (job.bagCount > d.capacity) return false;
      const until = this.declinedBy.get(job.id)?.get(d.id);
      if (until && until > nowMs) return false;
      return true;
    });
  }

  /* ----------------------------------------------------------- soft scoring */

  /**
   * Displacement is the term that makes roaming safe. An unbounded job removes
   * a supply unit from its zone for the duration, and that costs nothing at
   * 14:00 in a well-supplied zone and a great deal at 17:30. Price it and the
   * gating happens by itself -- no rule saying "no long runs at dinner".
   */
  displacementCost(job, driver, nowMs = this.now()) {
    if (job.kind !== 'ROAMING') return 0;
    const absenceMin = travelMinutes(job.pickup, job.dropoff) * 1.8;
    const pending = this.jobs.pendingInZone(driver.zone).length;
    const ratio = this.supply.supplyRatio(driver.zone, pending);
    const shortfallRisk = ratio >= 2 ? 0 : Math.max(0, (2 - ratio) / 2);
    return absenceMin * shortfallRisk;
  }

  /** Everything this driver is carrying, first order first. */
  runOf(driverId) {
    return this.jobs.all()
      .filter((j) => j.driverId === driverId && ACTIVE.includes(j.status))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The next job lined up for this driver, if any. */
  nextOf(driverId) {
    return this.jobs.all().find((j) => j.status === 'NEXT' && j.driverId === driverId) ?? null;
  }

  /**
   * Could `job` be this driver's next job? Returns the timing, or null.
   * The driver carries exactly one order, already collected, and has nothing
   * lined up. They finish their drop (ride to the door plus door time), ride
   * to the next store, and must get there no later than the food is ready,
   * and no more than CHAIN.maxWaitMin before it.
   */
  chainFit(job, driver, nowMs = this.now()) {
    if (!driver?.activeJobId || !driver.position) return null;
    const run = this.runOf(driver.id);
    if (run.length !== 1 || !run[0].collectedAt) return null;
    if (this.nextOf(driver.id)) return null;
    const cur = run[0];
    const freeAt = nowMs + (legMinutes(driver.position, cur.dropoff).minutes + CHAIN.doorMin) * 60000;
    const arriveAt = freeAt + legMinutes(cur.dropoff, job.pickup).minutes * 60000;
    const ready = readyAt(job, this.gate);
    if (arriveAt > ready) return null;
    if (ready - arriveAt > CHAIN.maxWaitMin * 60000) return null;
    return { after: cur.id, freeAt, arriveAt, readyAt: ready,
      waitMin: Number(((ready - arriveAt) / 60000).toFixed(1)) };
  }

  /**
   * Offer next jobs before anything else is offered. Only single orders:
   * an order that would stack with another waiting order is left to stack.
   * Each chainable driver gets the order whose food will be ready closest to
   * when they arrive, so nobody stands at a counter for long.
   */
  chainPass(nowMs = this.now()) {
    const offered = new Set([...this.offers.values()].map((o) => o.driverId));
    const pool = this.jobs.pending().filter((j) => !this.offers.has(j.id)
      && (j.bagCount ?? 1) <= 3);
    if (!pool.length) return 0;
    // Any waiting order it could stack with, due yet or not, rules it out.
    const single = pool.filter((j) => !pool.some((o) => o !== j
      && canJoin([j], o, this.gate, nowMs).ok));
    const drivers = [...this.supply.drivers.values()].filter((d) => d.activeJobId && d.position
      && !offered.has(d.id) && d.state !== SUPPLY.OFFLINE);
    let n = 0;
    const taken = new Set();
    for (const d of drivers) {
      let best = null;
      for (const j of single) {
        if (taken.has(j.id)) continue;
        if (!this.supply.acceptsKind(d.state, j.kind)) continue;
        if (j.requiredCapabilities?.some((c) => !d.capabilities.includes(c))) continue;
        if (j.bagCount > d.capacity) continue;
        const until = this.declinedBy.get(j.id)?.get(d.id);
        if (until && until > nowMs) continue;
        const fit = this.chainFit(j, d, nowMs);
        if (fit && (!best || fit.waitMin < best.fit.waitMin)) best = { j, fit };
      }
      if (!best) continue;
      taken.add(best.j.id);
      this.offerBatch([best.j], d, nowMs, { chain: best.fit });
      n += 1;
    }
    return n;
  }

  /** Make the lined-up job current once the driver's box is empty. */
  promoteNext(driverId) {
    const next = this.nextOf(driverId);
    if (!next || this.runOf(driverId).length) return null;
    this.jobs.setStatus(next.id, 'ASSIGNED', { nextAfter: null }, { driverId, kind: 'NEXT_STARTED' });
    this.supply.upsert(driverId, { activeJobId: next.id, activeBatchId: next.batchId ?? null });
    return next;
  }

  /** Put a lined-up job back in the pool for someone else. */
  handBackNext(driverId, reason) {
    const next = this.nextOf(driverId);
    if (!next) return null;
    const seen = this.declinedBy.get(next.id) ?? new Map();
    seen.set(driverId, this.now() + DECLINE_COOLDOWN_MS);
    this.declinedBy.set(next.id, seen);
    this.jobs.setStatus(next.id, 'PENDING', { driverId: null, batchId: null, nextAfter: null, runPlan: null },
      { driverId, kind: 'HANDED_BACK', reason });
    this.onHandBack?.(next, driverId, reason);
    return next;
  }

  /**
   * Every tick: start next jobs whose driver is free, and hand back any whose
   * driver would now reach the store more than CHAIN.handBackMin after the food
   * is ready (a long drop, a wrong address) or who went offline.
   */
  reviewNext(nowMs = this.now()) {
    for (const next of this.jobs.all().filter((j) => j.status === 'NEXT')) {
      const d = this.supply.get(next.driverId);
      if (!d || d.state === SUPPLY.OFFLINE) { this.handBackNext(next.driverId, 'Driver went offline'); continue; }
      const run = this.runOf(d.id);
      if (!run.length) { this.promoteNext(d.id); continue; }
      const cur = run[0];
      const pos = d.position ?? cur.dropoff;
      const free = nowMs + (legMinutes(pos, cur.dropoff).minutes + (cur.status === 'AT_CUSTOMER' ? 1 : CHAIN.doorMin)) * 60000;
      const arrive = free + legMinutes(cur.dropoff, next.pickup).minutes * 60000;
      if (arrive > readyAt(next, this.gate) + CHAIN.handBackMin * 60000) {
        this.handBackNext(d.id, 'Current drop is taking longer than planned');
      }
    }
  }

  /**
   * Can these orders be added to the run the driver is already on ("on the
   * run" stacking)? Only while they are still on the way to collect the first
   * order -- once collected they have left the store, and a second pickup is a
   * wasted trip back -- and only up to MAX_BATCH orders in all. The ready
   * window is measured from the first order on the run.
   *
   * @param jobOrBatch  one job, or the batch dispatch wants to offer
   */
  stackableWith(jobOrBatch, driver) {
    if (!driver.activeJobId) return null;
    const run = this.runOf(driver.id);
    if (!run.length || run.some((j) => j.collectedAt)) return null;
    const add = Array.isArray(jobOrBatch) ? jobOrBatch : [jobOrBatch];
    if (run.length + add.length > MAX_BATCH) return null;
    let batch = run, last = null;
    for (const j of add) {
      last = canJoin(batch, j, this.gate, this.now());
      if (!last.ok) return null;
      batch = [...batch, j];
    }
    return { with: run[0], run, ...last };
  }

  cost(job, driver, nowMs = this.now()) {
    const pickupEta = travelMinutes(driver.position, job.pickup);
    const slack = this.slackMinutes(job, nowMs);
    // Convex: flat while there is room, steep once slack runs out.
    const lateness = slack >= 0 ? Math.pow(1 / (1 + slack), 2) * 10 : 10 + Math.abs(slack) * 3;

    // A large discount, not a tiebreak. Stacking is the single biggest lever
    // on cost per order -- three from one kitchen cost R62 batched against
    // R101 dispatched separately -- so it should win against a moderately
    // closer idle driver.
    const stack = this.stackableWith(job, driver);
    const stackBonus = stack ? W.batchSynergy : 0;

    return W.pickupEta * pickupEta
      + W.latenessRisk * lateness
      + W.displacement * this.displacementCost(job, driver, nowMs)
      - W.equity * (1 / (1 + driver.recentJobs))
      - W.acceptance * driver.acceptanceRate
      - stackBonus;
  }

  /* ------------------------------------------------------------ assignment */

  /**
   * Sort by urgency, assign greedily, then run pairwise swap improvement.
   * At single-city volume this lands within a few percent of optimal and it is
   * debuggable at 2am, which matters more than the last few percent.
   */
  /**
   * Group eligible jobs into runs before anyone is offered anything.
   *
   * Greedy from the most urgent job outward: take the tightest-slack job, then
   * absorb every other eligible job that can legally ride with it. Grouping
   * before assignment is the whole point -- deciding one job at a time means
   * the second order from a kitchen is already committed to a different driver
   * by the time it is looked at.
   */
  formBatches(nowMs = this.now()) {
    const pool = this.jobs.pending()
      .filter((j) => this.isEligible(j, nowMs) && !this.offers.has(j.id))
      .sort((a, b) => this.slackMinutes(a, nowMs) - this.slackMinutes(b, nowMs));

    const used = new Set();
    const batches = [];

    for (const seed of pool) {
      if (used.has(seed.id)) continue;
      const batch = [seed];
      used.add(seed.id);

      for (const other of pool) {
        if (used.has(other.id) || batch.length >= MAX_BATCH) continue;
        const res = canJoin(batch, other, this.gate, nowMs);
        if (res.ok) { batch.push(other); used.add(other.id); }
      }
      batches.push(batch);
    }
    return batches;
  }

  /**
   * Why a job did not join a batch. Exposed for the back office, because a
   * dispatcher that silently declines to group orders is impossible to trust
   * or debug -- "it should have stacked these" needs an answer.
   */
  explainBatching(nowMs = this.now()) {
    const pool = this.jobs.pending().filter((j) => this.isEligible(j, nowMs));
    const out = [];
    for (let i = 0; i < pool.length; i++) {
      for (let k = i + 1; k < pool.length; k++) {
        const res = canJoin([pool[i]], pool[k], this.gate, nowMs);
        out.push({
          a: pool[i].orderNumber ?? pool[i].id,
          b: pool[k].orderNumber ?? pool[k].id,
          stackable: res.ok,
          reason: res.ok ? null : res.reason,
        });
      }
    }
    return out;
  }

  solve(nowMs = this.now()) {
    const batches = this.formBatches(nowMs);

    const taken = new Set();
    const pairs = [];

    for (const batch of batches) {
      // Score the batch on its seed -- the most urgent job in it -- but any
      // candidate must be able to serve every job in the run.
      const seed = batch[0];
      const cands = this.candidates(seed, nowMs).filter((d) => {
        if (taken.has(d.id)) return false;
        // A driver already on a run can only take what fits on it.
        if (d.activeJobId && !this.stackableWith(batch, d)) return false;
        return batch.every((j) => {
          if (this.declinedBy.get(j.id)?.get(d.id) > nowMs) return false;
          if (j.requiredCapabilities?.some((c) => !d.capabilities.includes(c))) return false;
          return true;
        });
      });
      if (!cands.length) continue;

      // A driver cannot carry more bags than they have space for, across the
      // whole run rather than per order.
      const bags = batch.reduce((a, j) => a + (j.bagCount ?? 1), 0);
      const able = cands.filter((d) => bags <= (d.capacity ?? 3) + 2);
      const pick = able.length ? able : cands;

      let best = null, bestCost = Infinity;
      for (const d of pick) {
        const c = batch.reduce((a, j) => a + this.cost(j, d, nowMs), 0) / batch.length;
        if (c < bestCost) { bestCost = c; best = d; }
      }
      if (best) { taken.add(best.id); pairs.push({ batch, driver: best, cost: bestCost }); }
    }

    // One pass of pairwise swaps: does exchanging two assignments reduce total
    // cost? Cheap, and it fixes the common case where the greedy pass gave the
    // closest driver to the first batch rather than the one that needed them.
    const avg = (batch, driver) =>
      batch.reduce((a, j) => a + this.cost(j, driver, nowMs), 0) / batch.length;

    for (let i = 0; i < pairs.length; i++) {
      for (let k = i + 1; k < pairs.length; k++) {
        const a = pairs[i], b = pairs[k];
        const swapped = avg(a.batch, b.driver) + avg(b.batch, a.driver);
        if (swapped < a.cost + b.cost - 0.01) {
          const tmp = a.driver; a.driver = b.driver; b.driver = tmp;
          a.cost = avg(a.batch, a.driver);
          b.cost = avg(b.batch, b.driver);
        }
      }
    }
    return pairs;
  }

  /**
   * Ask OSRM, in the background, for road times between the stops that could
   * end up on a run: pending orders, most urgent first, and runs still on the
   * way to their first pickup. The next tick plans on road times.
   */
  warmRunLegs(nowMs = this.now()) {
    const pts = [];
    const add = (j) => { pts.push(j.pickup, j.dropoff); };
    for (const j of this.jobs.all()) {
      if (j.driverId && ACTIVE.includes(j.status) && !j.collectedAt) add(j);
    }
    this.jobs.pending()
      .sort((a, b) => this.slackMinutes(a, nowMs) - this.slackMinutes(b, nowMs))
      .forEach(add);
    warmLegsInBackground(pts.slice(0, TABLE_MAX_POINTS));
  }

  /** The best route for these orders, with ready times from the ready gate. */
  planFor(jobs, nowMs = this.now()) {
    return planRun(jobs, { readyAt: (j) => readyAt(j, this.gate), now: nowMs });
  }

  tick(nowMs = this.now()) {
    this.expireOffers(nowMs);
    this.reviewNext(nowMs);
    this.warmRunLegs(nowMs);
    this.chainPass(nowMs);
    const pairs = this.solve(nowMs);
    for (const { batch, driver } of pairs) this.offerBatch(batch, driver, nowMs);
    return pairs.length;
  }

  /* --------------------------------------------------------------- offers */

  /**
   * Offer a whole run. All or nothing: a driver taking the well-tipped order
   * and leaving its neighbour would defeat the point and strand the other
   * customer, so the batch is accepted or declined as one.
   */
  offerBatch(batch, driver, nowMs = this.now(), { chain = null } = {}) {
    const expiresAt = nowMs + OFFER_TIMEOUT_MS + (batch.length - 1) * 5000;
    const batchId = `RUN-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    // On the run: the driver sees the whole trip they would end up doing, in
    // the order they will do it. The same route is stamped on accept.
    // A next job is its own trip: it never joins the run in the driver's box.
    const carrying = chain ? [] : this.runOf(driver.id);
    const whole = [...carrying, ...batch];
    const plan = this.planFor(whole, nowMs);
    const routeOpts = { readyAt: (j) => readyAt(j, this.gate), now: nowMs, fresh: true };

    for (const job of batch) {
      this.offers.set(job.id, { driverId: driver.id, expiresAt, batchId, plan: planStamp(plan),
        chainAfter: chain?.after ?? null });
      this.jobs.setStatus(job.id, 'OFFERED', { batchId });
    }

    this.onOffer?.({
      batchId,
      jobs: batch,
      carrying,
      driverId: driver.id,
      expiresAt,
      stops: plan.stops,
      route: routeMinutes(whole, routeOpts),
      routeSource: plan.source,
      marginal: marginalDistances(whole, routeOpts).filter((m) => batch.some((j) => j.id === m.jobId)),
      storeCount: storeCount(whole),
      sameCustomer: isSameCustomer(whole),
      next: chain ? { afterJobId: chain.after,
        freeInMinutes: Math.max(0, Math.round((chain.freeAt - nowMs) / 60000)),
        waitAtStoreMinutes: Math.round(chain.waitMin) } : null,
    });
  }

  /** Kept for single-job callers and tests. */
  offer(job, driver, nowMs = this.now()) {
    return this.offerBatch([job], driver, nowMs);
  }

  /** Every job sharing a run with this one. */
  batchOf(jobId) {
    const b = this.offers.get(jobId)?.batchId;
    if (!b) return [jobId];
    return [...this.offers.entries()].filter(([, o]) => o.batchId === b).map(([id]) => id);
  }

  /**
   * A declined or timed-out offer returns the job to the pool. It never dies
   * with one driver. Acceptance rate is tracked and fed back into scoring, or
   * drivers learn to cherry-pick and dispatch latency quietly degrades.
   */
  decline(jobId, driverId, { timedOut = false, cascade = true } = {}) {
    const offer = this.offers.get(jobId);
    if (!offer || offer.driverId !== driverId) return false;

    // Declining one job declines the run it belongs to. Leaving the siblings
    // offered to a driver who just refused their neighbour is worse than
    // starting again.
    if (cascade && offer.batchId) {
      for (const id of this.batchOf(jobId)) {
        if (id !== jobId) this.decline(id, driverId, { timedOut, cascade: false });
      }
    }
    this.offers.delete(jobId);

    // A timeout is not a refusal. A driver at a robot with the phone in their
    // pocket should see the job again shortly; someone who actively declined
    // it should not be pestered, but should still be eligible eventually
    // rather than never.
    const cooldown = timedOut ? TIMEOUT_COOLDOWN_MS : DECLINE_COOLDOWN_MS;
    const seen = this.declinedBy.get(jobId) ?? new Map();
    seen.set(driverId, this.now() + cooldown);
    this.declinedBy.set(jobId, seen);
    this.jobs.setStatus(jobId, 'PENDING');
    const d = this.supply.get(driverId);
    if (d) {
      this.supply.upsert(driverId, {
        acceptanceRate: Math.max(0.2, d.acceptanceRate * (timedOut ? 0.94 : 0.97)),
      });
    }
    return true;
  }

  accept(jobId, driverId) {
    const offer = this.offers.get(jobId);
    if (!offer || offer.driverId !== driverId) {
      // Say why: a driver tapping Accept a moment too late should hear that
      // the offer expired, not that it was "no longer valid".
      const gone = this.expired.get(jobId);
      return { ok: false, reason: gone?.driverId === driverId ? 'Offer expired' : 'Offer no longer valid' };
    }
    if (this.now() > offer.expiresAt) {
      this.decline(jobId, driverId, { timedOut: true });
      return { ok: false, reason: 'Offer expired' };
    }

    const ids = this.batchOf(jobId);

    // A next job: lined up behind the order in the box, not added to it. If
    // the driver already finished that drop, it is simply their job now.
    const after = offer.chainAfter ? this.jobs.get(offer.chainAfter) : null;
    if (after && after.driverId === driverId && ACTIVE.includes(after.status) && !this.nextOf(driverId)) {
      const lined = [];
      for (const id of ids) {
        this.offers.delete(id);
        this.declinedBy.delete(id);
        const j = this.jobs.setStatus(id, 'NEXT', { driverId, batchId: offer.batchId,
          nextAfter: after.id, runPlan: offer.plan ?? null });
        if (j) lined.push(j);
      }
      const d = this.supply.get(driverId);
      this.supply.upsert(driverId, {
        recentJobs: (d?.recentJobs ?? 0) + lined.length,
        acceptanceRate: Math.min(1, (d?.acceptanceRate ?? 1) * 1.02),
      });
      const carrying = this.runOf(driverId);
      return { ok: true, job: carrying[0], jobs: carrying, added: lined, next: lined[0] ?? null,
        batchId: carrying[0]?.batchId ?? null, stops: routeStops(carrying) };
    }

    // On the run: the new order joins the run the driver is already on, under
    // its batch id, and the first order stays the anchor.
    const carrying = this.runOf(driverId);
    const batchId = carrying[0]?.batchId ?? offer.batchId ?? null;
    for (const j of carrying) {
      if (j.batchId !== batchId) this.jobs.setStatus(j.id, j.status, { batchId });
    }
    const accepted = [];
    for (const id of ids) {
      this.offers.delete(id);
      this.declinedBy.delete(id);
      const j = this.jobs.get(id);
      if (!j) continue;
      this.jobs.setStatus(id, 'ASSIGNED', { driverId, batchId });
      accepted.push(j);
    }
    const run = [...carrying, ...accepted];

    // Fix the route the driver was offered, so it never reshuffles mid-run.
    const stamp = offer.plan ?? planStamp(this.planFor(run));
    for (const j of run) this.jobs.patch(j.id, { runPlan: stamp });

    const d = this.supply.get(driverId);
    this.supply.upsert(driverId, {
      // The run's first job is the anchor; the rest hang off the batch id.
      activeJobId: run[0]?.id ?? jobId,
      activeBatchId: batchId,
      recentJobs: (d?.recentJobs ?? 0) + accepted.length,
      acceptanceRate: Math.min(1, (d?.acceptanceRate ?? 1) * 1.02),
      state: run.some((j) => j.kind === 'ROAMING') ? SUPPLY.ROAMING_ACTIVE : d?.state,
    });

    // The whole run, so the app replaces what it holds with the complete trip.
    return {
      ok: true,
      job: run[0],
      jobs: run,
      added: accepted,
      batchId,
      stops: routeStops(run),
    };
  }

  expireOffers(nowMs = this.now()) {
    for (const [jobId, offer] of this.offers) {
      if (nowMs > offer.expiresAt) {
        this.expired.set(jobId, { driverId: offer.driverId, at: nowMs });
        this.decline(jobId, offer.driverId, { timedOut: true });
      }
    }
    // Remember expiries for ten minutes, long enough to answer a late tap.
    for (const [jobId, e] of this.expired) if (nowMs - e.at > 10 * 60_000) this.expired.delete(jobId);
  }
}
