/**
 * Order stacking.
 *
 * Up to two orders on one run when the pickups sit close together and the
 * drop-offs sit close together. The driver earns more per hour, the platform
 * pays less per order, and the customer barely notices — provided the second
 * order does not make the first one late.
 *
 * THE CONSTRAINT THAT MATTERS
 * Our analysis of 11,900 Uber Eats orders found batched orders waited 55%
 * longer at the restaurant than single ones — a 9.93 minute median against
 * 6.42 at Panarottis, 6.63 against 4.13 at RocoMamas. Batching is not free.
 * It buys efficiency with pickup delay, and the moment that delay makes the
 * first order late the trade has gone the wrong way.
 *
 * So eligibility is not only geography. Ready times must be compatible, and
 * the marginal lateness inflicted on every order already in the batch has to
 * stay under a threshold.
 *
 * TWO SHAPES OF BATCH
 *   SAME_STORE   two orders from one kitchen, dropping near each other
 *   MULTI_STORE  different kitchens within 100 m, dropping near each other,
 *                including the case of one customer ordering from two places
 *
 * THE READY WINDOW
 * The first order on the run sets the clock: its predicted ready time is the
 * anchor, and a second order may join only if it will be ready within
 * READY_WINDOW_MIN of it, earlier or later. The same rule applies whether the
 * two orders are grouped before anyone is offered them, or the second is added
 * to a driver already riding to collect the first ("on the run").
 */

import { metresBetween } from './supply.js';
import { legMinutes } from './routing.js';
import { jobRoadKm } from './limits.js';
import { SETTING_DEFAULTS } from './settings.js';

/**
 * The rules below are the defaults. Each can be changed per zone in the back
 * office Settings tab (src/settings.js); `canJoin` takes the zone's values
 * through `settingsFor`. Where two orders on a run are in different zones,
 * the stricter value applies.
 */
export const MAX_BATCH = SETTING_DEFAULTS.stackMaxOrders;

/** The stacking rules from the brief: pickups within 100 m, drop-offs within 1 km. */
export const PICKUP_CLUSTER_M = SETTING_DEFAULTS.stackPickupM;
export const DROPOFF_CLUSTER_M = SETTING_DEFAULTS.stackDropoffM;

/**
 * How much later any one order may arrive because it shares a run, compared
 * with being delivered alone. Food goes cold; this is the number that stops
 * efficiency eating quality. It applies to every order on the run, the new one
 * included, not to the run's total.
 */
export const MAX_ADDED_LATENESS_MIN = SETTING_DEFAULTS.stackMaxExtraMin;

/** A second order must be ready within this of the first order's ready time. */
export const READY_WINDOW_MIN = SETTING_DEFAULTS.stackReadyWindowMin;

/** The rules for a set of orders: each zone's values, the stricter where they differ. */
export function runRules(orders, settingsFor = null) {
  const all = orders.map((j) => ({ ...SETTING_DEFAULTS, ...(settingsFor ? settingsFor(j.zone) : {}) }));
  const min = (k) => Math.min(...all.map((x) => x[k]));
  return {
    maxOrders: min('stackMaxOrders'),
    pickupM: min('stackPickupM'),
    dropoffM: min('stackDropoffM'),
    readyWindowMin: min('stackReadyWindowMin'),
    maxExtraMin: min('stackMaxExtraMin'),
    maxReadyToDropMin: min('maxReadyToDropMin'),
    noStackBeyondKm: (i) => all[i].noStackBeyondKm,
    settings: (i) => all[i],
  };
}

/** When an order's food is predicted to be ready, in ms. */
export function readyAt(job, gate) {
  return job.createdAt + gate.predictPrepMinutes(job.storeId, job.merchantPrepMinutes ?? null) * 60000;
}

const pt = (p) => ({ lat: p.lat ?? p.latitude, lng: p.lng ?? p.longitude });

/** Every pairwise distance in a set is within `limit`. */
function clustered(points, limit) {
  for (let i = 0; i < points.length; i++) {
    for (let k = i + 1; k < points.length; k++) {
      if (metresBetween(points[i], points[k]) > limit) return false;
    }
  }
  return true;
}

/**
 * Can `candidate` join `batch`?
 * Returns { ok, reason } so a dispatcher log says why a batch was refused.
 */
export function canJoin(batch, candidate, gate, now = Date.now(), settingsFor = null) {
  const all = [...batch, candidate];
  const r = runRules(all, settingsFor);
  if (batch.length >= r.maxOrders) {
    return { ok: false, reason: r.maxOrders <= 1 ? 'batching is switched off' : `batch already at ${r.maxOrders}` };
  }

  // Long deliveries ride alone: past the zone's limit, by road.
  for (const [i, j] of all.entries()) {
    const km = jobRoadKm(j, r.settings(i)), max = r.noStackBeyondKm(i);
    if (km > max) {
      return { ok: false, reason: `order ${j.id} is ${km.toFixed(1)} km by road (no stacking beyond ${max} km)` };
    }
  }
  const maxReadyToDropMin = r.maxReadyToDropMin;

  const pickups = all.map((j) => pt(j.pickup));
  if (!clustered(pickups, r.pickupM)) {
    return { ok: false, reason: `pickups more than ${r.pickupM} m apart` };
  }

  const dropoffs = all.map((j) => pt(j.dropoff));
  if (!clustered(dropoffs, r.dropoffM)) {
    return { ok: false, reason: `drop-offs more than ${r.dropoffM} m apart` };
  }

  // Ready-time compatibility, measured from the first order. Adding a slow
  // kitchen to a fast one means the first order sits under a heat lamp while
  // the driver waits for the second.
  const anchor = readyAt(all[0], gate);
  const gapMin = Math.max(...all.slice(1).map((j) => Math.abs(readyAt(j, gate) - anchor))) / 60000;
  if (gapMin > r.readyWindowMin) {
    return { ok: false, reason: `ready times ${gapMin.toFixed(0)} min apart (window ${r.readyWindowMin} min from the first order)` };
  }

  // No order may arrive more than MAX_ADDED_LATENESS_MIN later than it would
  // alone, on the best route for the whole run.
  // And no order on the run more than maxReadyToDropMin from ready to door.
  const plan = planRun(all, { readyAt: (j) => readyAt(j, gate), now,
    maxExtraMin: r.maxExtraMin, maxReadyToDropMin });
  if (!plan.feasible) {
    const slow = plan.perOrder.find((o) => o.readyToDropMin > maxReadyToDropMin);
    if (slow) {
      return { ok: false, reason: `order ${slow.jobId} would take ${slow.readyToDropMin.toFixed(1)} min from ready to drop-off (limit ${maxReadyToDropMin} min)` };
    }
    const worst = plan.perOrder.reduce((a, b) => (b.extraMin > a.extraMin ? b : a));
    return { ok: false, reason: `order ${worst.jobId} would arrive ${worst.extraMin.toFixed(1)} min later than alone (limit ${r.maxExtraMin} min)` };
  }
  const added = Math.max(0, ...plan.perOrder.map((o) => o.extraMin));
  return { ok: true, addedMinutes: Number(added.toFixed(1)), readyGapMin: Number(gapMin.toFixed(1)),
    perOrder: plan.perOrder, plan: planStamp(plan) };
}

/* ------------------------------------------------------------ the run route
 *
 * Which order to visit the stops in. This is a pickup-and-delivery problem
 * with ready times, not a plain travelling salesman: each order's drop-off
 * must come after its pickup, and food that is not ready yet means waiting.
 *
 * A run is at most MAX_BATCH orders, so there are only a handful of legal
 * stop orders (6 for two orders from two stores, 90 for three). We score every
 * one of them and take the best, which is exact and takes microseconds. Leg
 * times are road times from OSRM when the dispatcher has fetched them, else
 * the straight-line estimate.
 *
 * THE SCORE
 * When the last stop is reached, plus when each customer gets their food,
 * all counted from the start of the run and including any wait at a store.
 * The first part is the driver's time; the second is the customers'. Shortest
 * distance alone would happily make one customer wait for the other's detour.
 *
 * STABLE ROUTES
 * A driver must never see the stops reshuffle mid-run because a ready time or
 * a road time was revised. The route chosen when a run is offered is stamped
 * on its jobs (`runPlan`) on accept, and every later view follows the stamp.
 * Stops already done stay at the front.
 */

const stopKey = (s) => (s.kind === 'PICKUP' ? `P:${s.storeId}` : `D:${s.jobIds[0]}`);

/** Pickups (one per store) and drop-offs (one per order) for a set of jobs. */
function buildStops(jobs) {
  const pickups = new Map();
  for (const j of jobs) {
    const s = pickups.get(j.storeId);
    if (s) { s.jobIds.push(j.id); continue; }
    pickups.set(j.storeId, { kind: 'PICKUP', storeId: j.storeId, at: pt(j.pickup),
      name: j.pickup?.name ?? j.storeId, jobIds: [j.id] });
  }
  const drops = jobs.map((j) => ({ kind: 'DROPOFF', at: pt(j.dropoff),
    name: j.dropoff?.name ?? 'Delivery address', jobIds: [j.id] }));
  return { pickups: [...pickups.values()], drops };
}

/** Every legal order of `stops`: a drop-off only after its order's pickup. */
function* sequences(stops, done = new Set()) {
  if (!stops.length) { yield []; return; }
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    if (s.kind === 'DROPOFF' && !done.has(s.jobIds[0])) continue;
    const next = new Set(done);
    if (s.kind === 'PICKUP') for (const id of s.jobIds) next.add(id);
    const rest = [...stops.slice(0, i), ...stops.slice(i + 1)];
    for (const tail of sequences(rest, next)) yield [s, ...tail];
  }
}

/** Walk one sequence: arrival times, waits and drive minutes. */
function walk(seq, { startAt, readyMs, source, from = null }) {
  // From the driver's position when given: stores already visited are behind
  // them and cost nothing more.
  let t = startAt, drive = 0, prev = from ? { at: from } : null;
  const dropAt = new Map();
  for (const s of seq) {
    if (from && s.done) continue;
    if (prev) {
      const leg = legMinutes(prev.at, s.at);
      if (leg.source === 'estimated') source.estimated = true;
      drive += leg.minutes;
      t += leg.minutes * 60000;
    }
    if (s.kind === 'PICKUP' && !s.done) t = Math.max(t, ...s.jobIds.map(readyMs));
    if (s.kind === 'DROPOFF') dropAt.set(s.jobIds[0], t);
    prev = s;
  }
  return { finish: t, drive, dropAt };
}

/**
 * The best stop order for a run.
 *
 * @param jobs   the orders on the run (delivered ones already removed)
 * @param opts.readyAt     job -> ms its food is ready (optional; none = ready now)
 * @param opts.now         ms the run starts at its first stop (default now)
 * @param opts.maxExtraMin per-order limit; sets `feasible`
 * @param opts.maxReadyToDropMin  on a run of two or more, no order may reach
 *                         its customer more than this after its food is ready;
 *                         sets `feasible`
 * @param opts.from        the driver's position: plan from there, not from the
 *                         first stop
 * @returns {{ stops, perOrder: [{jobId, extraMin, readyToDropMin}], feasible, driveMinutes, source }}
 */
export function planRun(jobs, opts = {}) {
  const now = opts.now ?? Date.now();
  const readyMs = (id) => {
    const j = jobs.find((x) => x.id === id);
    const r = j && opts.readyAt ? opts.readyAt(j) : null;
    return Number.isFinite(r) ? r : now;
  };
  const { pickups, drops } = buildStops(jobs);
  // A store whose orders are all collected is done: it stays first, not re-planned.
  const isDone = (s) => s.jobIds.every((id) => jobs.find((j) => j.id === id)?.collectedAt);
  const fixed = pickups.filter(isDone).map((s) => ({ ...s, done: true }));
  const open = [...pickups.filter((s) => !isDone(s)), ...drops];
  const collected = new Set(fixed.flatMap((s) => s.jobIds));

  const source = { estimated: false };
  let best = null;
  for (const tail of sequences(open, collected)) {
    const seq = [...fixed, ...tail];
    const w = walk(seq, { startAt: now, readyMs, source, from: opts.from ? pt(opts.from) : null });
    // Each order alone: from its store, ready time, straight to the customer.
    const perOrder = jobs.map((j) => {
      const alone = Math.max(now, readyMs(j.id)) + legMinutes(pt(j.pickup), pt(j.dropoff)).minutes * 60000;
      return { jobId: j.id,
        extraMin: Number((Math.max(0, w.dropAt.get(j.id) - alone) / 60000).toFixed(1)),
        readyToDropMin: Number((Math.max(0, w.dropAt.get(j.id) - readyMs(j.id)) / 60000).toFixed(1)) };
    });
    const tooSlow = opts.maxReadyToDropMin != null && jobs.length > 1
      && perOrder.some((o) => o.readyToDropMin > opts.maxReadyToDropMin);
    const feasible = !tooSlow
      && (opts.maxExtraMin == null || perOrder.every((o) => o.extraMin <= opts.maxExtraMin));
    const score = (w.finish - now) + [...w.dropAt.values()].reduce((a, t) => a + (t - now), 0);
    const cand = { seq, perOrder, feasible, score, drive: w.drive, tie: seq.map(stopKey).join('>') };
    // Feasible beats infeasible, then the lower score, then less driving, then
    // a fixed order so the same inputs always give the same route.
    if (!best
      || (cand.feasible && !best.feasible)
      || (cand.feasible === best.feasible && (cand.score < best.score - 1000
        || (Math.abs(cand.score - best.score) <= 1000 && (cand.drive < best.drive - 0.05
          || (Math.abs(cand.drive - best.drive) <= 0.05 && cand.tie < best.tie)))))) {
      best = cand;
    }
  }
  if (!best) return { stops: [], perOrder: [], feasible: true, driveMinutes: 0, source: 'osrm' };
  return {
    stops: best.seq.map(({ done, ...s }) => s),
    perOrder: best.perOrder,
    feasible: best.feasible,
    driveMinutes: Number(best.drive.toFixed(1)),
    source: source.estimated ? 'estimated' : 'osrm',
  };
}

/** What gets stamped on each job of an accepted run. */
export function planStamp(plan) {
  return { order: plan.stops.map(stopKey), source: plan.source, at: Date.now() };
}

/**
 * Order the stops of a run.
 *
 * Follows the route stamped on the jobs when the run was accepted, so the
 * driver never sees it reshuffle. Without a stamp (an offer being built, or a
 * run from before stamping existed) it plans the best route now.
 *
 * @param opts  passed to planRun when planning fresh (readyAt, now)
 */
export function routeStops(jobs, opts = {}) {
  if (!jobs.length) return [];
  const order = jobs[0].runPlan?.order;
  const stamped = !opts.fresh && Array.isArray(order)
    && jobs.every((j) => j.runPlan?.order === order || sameOrder(j.runPlan?.order, order))
    && jobs.every((j) => order.includes(`D:${j.id}`) && order.includes(`P:${j.storeId}`));
  if (!stamped) return planRun(jobs, opts).stops;

  const { pickups, drops } = buildStops(jobs);
  const byKey = new Map([...pickups, ...drops].map((s) => [stopKey(s), s]));
  return order.map((k) => byKey.get(k)).filter(Boolean);
}

const sameOrder = (a, b) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && a.every((k, i) => k === b[i]);

/** Distance and time for the whole run, and per leg, on its route. */
export function routeMinutes(jobs, opts = {}) {
  const stops = routeStops(jobs, opts);
  let km = 0, minutes = 0;
  const legsOut = [];
  for (let i = 1; i < stops.length; i++) {
    // Kilometres stay straight-line: marginal pay is built on them, and moving
    // pay to road distance is a separate decision.
    const m = metresBetween(stops[i - 1].at, stops[i].at);
    const t = legMinutes(stops[i - 1].at, stops[i].at).minutes;
    km += m / 1000;
    minutes += t;
    legsOut.push({ from: stops[i - 1].name, to: stops[i].name,
      km: Number((m / 1000).toFixed(2)), minutes: Number(t.toFixed(1)) });
  }
  return { stops, legs: legsOut, km: Number(km.toFixed(2)), total: Number(minutes.toFixed(1)) };
}

/**
 * The marginal distance each order adds to the run.
 *
 * The first order carries the full route it would have had alone. Each
 * additional order carries only what it adds — which is the whole point of
 * batching, and the basis for its pay.
 */
export function marginalDistances(jobs, opts = {}) {
  const out = [];
  const full = routeMinutes(jobs, opts).km;
  for (let i = 0; i < jobs.length; i++) {
    const withOut = jobs.filter((_, k) => k !== i);
    const less = withOut.length ? routeMinutes(withOut, opts).km : 0;
    out.push({ jobId: jobs[i].id, marginalKm: Number(Math.max(0, full - less).toFixed(2)) });
  }
  return out;
}

/** Distinct stores in a batch. Two orders from one kitchen is one stop. */
export function storeCount(jobs) {
  return new Set(jobs.map((j) => j.storeId)).size;
}

/** Same customer ordering from two nearby places -- worth flagging to the driver. */
export function isSameCustomer(jobs) {
  if (jobs.length < 2) return false;
  const first = pt(jobs[0].dropoff);
  return jobs.every((j) => metresBetween(pt(j.dropoff), first) < 50);
}
