/**
 * Order stacking.
 *
 * Up to three orders on one run when the pickups sit close together and the
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
 *   SAME_STORE   several orders from one kitchen, dropping near each other
 *   MULTI_STORE  different kitchens within 500 m, dropping near each other,
 *                including the case of one customer ordering from two places
 */

import { metresBetween, travelMinutes } from './supply.js';

export const MAX_BATCH = 3;
export const PICKUP_CLUSTER_M = 500;
export const DROPOFF_CLUSTER_M = 500;

/**
 * How late an order already in the batch may be made by adding another.
 * Food goes cold; this is the number that stops efficiency eating quality.
 */
export const MAX_ADDED_LATENESS_MIN = 6;

/** Ready times more than this far apart mean someone waits too long. */
export const MAX_READY_SPREAD_MIN = 10;

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
export function canJoin(batch, candidate, gate, now = Date.now()) {
  if (batch.length >= MAX_BATCH) {
    return { ok: false, reason: `batch already at ${MAX_BATCH}` };
  }
  const all = [...batch, candidate];

  const pickups = all.map((j) => pt(j.pickup));
  if (!clustered(pickups, PICKUP_CLUSTER_M)) {
    return { ok: false, reason: `pickups more than ${PICKUP_CLUSTER_M} m apart` };
  }

  const dropoffs = all.map((j) => pt(j.dropoff));
  if (!clustered(dropoffs, DROPOFF_CLUSTER_M)) {
    return { ok: false, reason: `drop-offs more than ${DROPOFF_CLUSTER_M} m apart` };
  }

  // Ready-time compatibility. Adding a slow kitchen to a fast one means the
  // first order sits under a heat lamp while the driver waits for the second.
  const readyAt = all.map((j) => {
    const prep = gate.predictPrepMinutes(j.storeId, j.merchantPrepMinutes ?? null);
    return j.createdAt + prep * 60000;
  });
  const spreadMin = (Math.max(...readyAt) - Math.min(...readyAt)) / 60000;
  if (spreadMin > MAX_READY_SPREAD_MIN) {
    return { ok: false, reason: `ready times ${spreadMin.toFixed(0)} min apart` };
  }

  // Marginal lateness on the orders already in the batch.
  const before = routeMinutes(batch);
  const after = routeMinutes(all);
  const added = after.total - before.total;
  if (batch.length && added > MAX_ADDED_LATENESS_MIN) {
    return { ok: false, reason: `would add ${added.toFixed(1)} min to the existing orders` };
  }

  return { ok: true, addedMinutes: Number(added.toFixed(1)), readySpreadMin: Number(spreadMin.toFixed(1)) };
}

/**
 * Order the stops: every pickup first, then every drop-off, each leg nearest
 * first. Collecting everything before delivering anything keeps the food
 * together and is what a driver would do unprompted.
 *
 * Nearest-neighbour rather than optimal: with at most three orders the
 * difference is seconds, and a driver can follow a route they can predict.
 */
export function routeStops(jobs) {
  if (!jobs.length) return [];
  const stops = [];

  // Pickups, deduplicated -- two orders from one store is one stop.
  const seen = new Map();
  for (const j of jobs) {
    const key = j.storeId;
    if (seen.has(key)) { seen.get(key).jobIds.push(j.id); continue; }
    const stop = { kind: 'PICKUP', storeId: j.storeId, at: pt(j.pickup),
      name: j.pickup?.name ?? j.storeId, jobIds: [j.id] };
    seen.set(key, stop);
    stops.push(stop);
  }

  const drops = jobs.map((j) => ({ kind: 'DROPOFF', at: pt(j.dropoff),
    name: j.dropoff?.name ?? 'Delivery address', jobIds: [j.id] }));

  const ordered = [];
  let cursor = stops[0]?.at;
  const remaining = [...stops];
  while (remaining.length) {
    remaining.sort((a, b) => metresBetween(cursor, a.at) - metresBetween(cursor, b.at));
    const next = remaining.shift();
    ordered.push(next);
    cursor = next.at;
  }
  const remainingDrops = [...drops];
  while (remainingDrops.length) {
    remainingDrops.sort((a, b) => metresBetween(cursor, a.at) - metresBetween(cursor, b.at));
    const next = remainingDrops.shift();
    ordered.push(next);
    cursor = next.at;
  }
  return ordered;
}

/** Distance and time for the whole run, and per leg. */
export function routeMinutes(jobs) {
  const stops = routeStops(jobs);
  let km = 0, minutes = 0;
  const legs = [];
  for (let i = 1; i < stops.length; i++) {
    const m = metresBetween(stops[i - 1].at, stops[i].at);
    const t = travelMinutes(stops[i - 1].at, stops[i].at);
    km += m / 1000;
    minutes += t;
    legs.push({ from: stops[i - 1].name, to: stops[i].name,
      km: Number((m / 1000).toFixed(2)), minutes: Number(t.toFixed(1)) });
  }
  return { stops, legs, km: Number(km.toFixed(2)), total: Number(minutes.toFixed(1)) };
}

/**
 * The marginal distance each order adds to the run.
 *
 * The first order carries the full route it would have had alone. Each
 * additional order carries only what it adds — which is the whole point of
 * batching, and the basis for its pay.
 */
export function marginalDistances(jobs) {
  const out = [];
  for (let i = 0; i < jobs.length; i++) {
    const withOut = jobs.filter((_, k) => k !== i);
    const full = routeMinutes(jobs).km;
    const less = withOut.length ? routeMinutes(withOut).km : 0;
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
