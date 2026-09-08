/**
 * Dispatch engine.
 *
 * Runs a short batching window rather than assigning each job on arrival.
 * Greedy instant assignment is locally sensible and globally poor -- it burns
 * the closest driver on whichever job happened to arrive first.
 */

import { SUPPLY, metresBetween, travelMinutes } from './supply.js';
import { canJoin, routeStops, routeMinutes, marginalDistances, storeCount,
  isSameCustomer, MAX_BATCH } from './batching.js';

export const TICK_MS = 3000;              // batching window
export const OFFER_TIMEOUT_MS = 25_000;
export const BASE_RADIUS_M = 6000;
export const RADIUS_GROWTH_PER_MIN = 900;  // widen as a job ages
export const MAX_RADIUS_M = 15000;

/** How long a driver is skipped for a job after a missed or refused offer. */
export const TIMEOUT_COOLDOWN_MS = 90_000;
export const DECLINE_COOLDOWN_MS = 10 * 60_000;

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
  constructor({ readyGate, supply, jobs, onOffer, now = () => Date.now() }) {
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

    return [...this.supply.available(), ...stackers].filter((d) => {
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

  /**
   * Jobs the driver is already carrying that this one could ride along with.
   *
   * Full simultaneous multi-stop needs the driver app to show a stop list,
   * which it does not yet. What this does instead is make a stackable job
   * strongly preferred for the driver already holding a compatible one, so
   * they get them back to back from the same kitchen rather than a second
   * driver being sent to the same door. Most of the efficiency, none of the
   * UI risk.
   */
  stackableWith(job, driver) {
    if (!driver.activeJobId) return null;
    const active = this.jobs.get(driver.activeJobId);
    if (!active || ['DELIVERED', 'FAILED', 'CANCELLED'].includes(active.status)) return null;
    // Already collected means the driver has left the store; a second pickup
    // there is a wasted trip back.
    if (active.collectedAt) return null;
    const res = canJoin([active], job, this.gate, this.now());
    return res.ok ? { with: active, ...res } : null;
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

  tick(nowMs = this.now()) {
    this.expireOffers(nowMs);
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
  offerBatch(batch, driver, nowMs = this.now()) {
    const expiresAt = nowMs + OFFER_TIMEOUT_MS + (batch.length - 1) * 5000;
    const batchId = `RUN-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    for (const job of batch) {
      this.offers.set(job.id, { driverId: driver.id, expiresAt, batchId });
      this.jobs.setStatus(job.id, 'OFFERED', { batchId });
    }

    this.onOffer?.({
      batchId,
      jobs: batch,
      driverId: driver.id,
      expiresAt,
      stops: routeStops(batch),
      route: routeMinutes(batch),
      marginal: marginalDistances(batch),
      storeCount: storeCount(batch),
      sameCustomer: isSameCustomer(batch),
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
    if (!offer || offer.driverId !== driverId) return { ok: false, reason: 'Offer no longer valid' };
    if (this.now() > offer.expiresAt) {
      this.decline(jobId, driverId, { timedOut: true });
      return { ok: false, reason: 'Offer expired' };
    }

    const ids = this.batchOf(jobId);
    const accepted = [];
    for (const id of ids) {
      this.offers.delete(id);
      this.declinedBy.delete(id);
      const j = this.jobs.get(id);
      if (!j) continue;
      this.jobs.setStatus(id, 'ASSIGNED', { driverId, batchId: offer.batchId ?? null });
      accepted.push(j);
    }

    const d = this.supply.get(driverId);
    this.supply.upsert(driverId, {
      // The run's first job is the anchor; the rest hang off the batch id.
      activeJobId: accepted[0]?.id ?? jobId,
      activeBatchId: offer.batchId ?? null,
      recentJobs: (d?.recentJobs ?? 0) + accepted.length,
      acceptanceRate: Math.min(1, (d?.acceptanceRate ?? 1) * 1.02),
      state: accepted.some((j) => j.kind === 'ROAMING') ? SUPPLY.ROAMING_ACTIVE : d?.state,
    });

    return {
      ok: true,
      job: accepted[0],
      jobs: accepted,
      batchId: offer.batchId ?? null,
      stops: routeStops(accepted),
    };
  }

  expireOffers(nowMs = this.now()) {
    for (const [jobId, offer] of this.offers) {
      if (nowMs > offer.expiresAt) this.decline(jobId, offer.driverId, { timedOut: true });
    }
  }
}
