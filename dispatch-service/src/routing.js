/**
 * Routing.
 *
 * We compute distance ourselves. Keychat sends us addresses and coordinates;
 * we work out the road distance and duration, and that is what the price is
 * built on. Their ETA is for their customer, ours is for the fee.
 *
 * WHY SELF-HOSTED OSRM AND NOT A MAPS API
 * Scoring every dispatch candidate through Google Directions would cost roughly
 * R750k a month at 10% national share -- about twenty-five times the entire
 * infrastructure bill. OSRM on one instance handles thousands of routes a
 * second against South African OSM data, for the price of the instance.
 * deploy/setup-osrm.sh builds and runs it on the server.
 *
 *   OSRM_URL=http://127.0.0.1:5000 npm start
 *
 * WHEN OSRM IS NOT CONFIGURED OR NOT ANSWERING
 * Falls back to straight-line distance times a detour factor. That is accurate
 * enough to RANK dispatch candidates, which is all the cost function needs, but
 * it is not accurate enough to bill on. Every quote and job records which was
 * used (`source`), the back office shows how many fell back, and the statement
 * carries it per order, so a dispute is settled by looking at `distanceSource`.
 *
 * Routes are cached briefly: a quote and the job created a minute later ask
 * for the same legs, and so do dispatch candidates at the same store.
 */

import { metresBetween, DETOUR_FACTOR, URBAN_KMH } from './supply.js';

const osrmUrl = () => (process.env.OSRM_URL ?? '').replace(/\/+$/, '') || null;
const timeoutMs = () => Number(process.env.OSRM_TIMEOUT_MS ?? 2500);

const CACHE_MAX = 5000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();   // key -> { at, value }, insertion order = LRU

/** Live counters for the back office and /health. */
const stats = { osrm: 0, fallback: 0, cacheHits: 0, lastError: null, lastErrorAt: null, lastOkAt: null };

export function routingStatus() {
  return {
    mode: osrmUrl() ? 'osrm' : 'estimated',
    osrmConfigured: !!osrmUrl(),
    ...stats,
    cacheSize: cache.size,
    runLegs: legStatus(),
  };
}

/** Test hook. */
export function resetRouting() {
  cache.clear();
  Object.assign(stats, { osrm: 0, fallback: 0, cacheHits: 0, lastError: null, lastErrorAt: null, lastOkAt: null });
}

/**
 * Accept {lat,lng} or {latitude,longitude}; return {lat,lng} numbers, or null
 * when the point is missing or not on the planet.
 */
export function point(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat ?? p.latitude);
  const lng = Number(p.lng ?? p.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;   // the classic "no GPS" default
  return { lat, lng };
}

function fallback(from, to) {
  const km = (metresBetween(from, to) / 1000) * DETOUR_FACTOR;
  return {
    km: Number(km.toFixed(2)),
    minutes: Number(((km / URBAN_KMH) * 60).toFixed(1)),
    source: 'estimated',
  };
}

const key = (a, b) => `${a.lat.toFixed(5)},${a.lng.toFixed(5)};${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;

function remember(k, value) {
  cache.delete(k);
  cache.set(k, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/**
 * Road distance and driving time between two points.
 * Never throws: a routing outage must degrade the price, not drop the order.
 */
export async function route(fromIn, toIn) {
  const from = point(fromIn), to = point(toIn);
  if (!from || !to) return { km: 0, minutes: 0, source: 'unknown' };
  const base = osrmUrl();
  if (!base) { stats.fallback += 1; return fallback(from, to); }

  const k = key(from, to);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    stats.cacheHits += 1;
    cache.delete(k); cache.set(k, hit);
    return hit.value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  const fail = (why) => {
    stats.fallback += 1; stats.lastError = why; stats.lastErrorAt = Date.now();
    return fallback(from, to);
  };
  try {
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const res = await fetch(`${base}/route/v1/driving/${coords}?overview=false&alternatives=false`,
      { signal: controller.signal });
    if (!res.ok) return fail(`OSRM answered ${res.status}`);
    const body = await res.json();
    const r = body?.routes?.[0];
    if (body?.code !== 'Ok' || !r) return fail(`OSRM: ${body?.code ?? 'no route'}`);

    // OSRM snaps each point to the nearest road. A point dropped in the sea or
    // on a farm 5 km from any road gives a confident, wrong answer. If the
    // road route is shorter than the straight line, or absurdly longer, the
    // snap went wrong: do not bill on it.
    const crowKm = metresBetween(from, to) / 1000;
    const km = r.distance / 1000;
    const snapM = Math.max(...(body.waypoints ?? []).map((w) => Number(w.distance) || 0), 0);
    if (km + 0.05 < crowKm * 0.95 || (crowKm > 0.3 && km > crowKm * 4 + 3) || snapM > 500) {
      return fail(`OSRM route rejected (road ${km.toFixed(2)} km, straight ${crowKm.toFixed(2)} km, snap ${Math.round(snapM)} m)`);
    }

    const value = { km: Number(km.toFixed(2)), minutes: Number((r.duration / 60).toFixed(1)), source: 'osrm' };
    stats.osrm += 1; stats.lastOkAt = Date.now();
    remember(k, value);
    return value;
  } catch (err) {
    // Timeout, connection refused, malformed response -- all the same answer.
    return fail(err?.name === 'AbortError' ? `OSRM timed out after ${timeoutMs()} ms` : `OSRM unreachable: ${err?.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------- leg times for runs
 *
 * Choosing the order of stops on a run needs the drive time between every pair
 * of stops, and it runs inside the dispatcher's synchronous 3-second tick. So
 * the tick never waits on the network: `legMinutes` answers from a cache of
 * OSRM table results and falls back to the straight-line estimate, and
 * `warmLegs` fills that cache in the background with one /table call for a
 * set of points. A stop pair first seen on one tick has road times by the next.
 *
 * Our osrm-routed allows 1000 points per table (deploy/setup-osrm.sh); we ask for
 * at most 100, the most urgent orders' stops, which keeps each call to milliseconds.
 */
const LEG_TTL_MS = 30 * 60 * 1000;
const LEG_MAX = 50000;
export const TABLE_MAX_POINTS = 100;
const legs = new Map();   // "a;b" -> { at, minutes }
const legKey = (a, b) => `${a.lat.toFixed(5)},${a.lng.toFixed(5)};${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
const tableStats = { tableCalls: 0, tableErrors: 0, legsCached: 0 };
let warming = null;

/**
 * Drive time between two stops, in minutes, never waiting on the network.
 * @returns {{ minutes: number, source: 'osrm'|'estimated' }}
 */
export function legMinutes(aIn, bIn) {
  const a = point(aIn), b = point(bIn);
  if (!a || !b) return { minutes: 0, source: 'unknown' };
  if (metresBetween(a, b) < 15) return { minutes: 0, source: 'osrm' };   // same place
  const hit = legs.get(legKey(a, b));
  if (hit && Date.now() - hit.at < LEG_TTL_MS) return { minutes: hit.minutes, source: 'osrm' };
  const km = (metresBetween(a, b) / 1000) * DETOUR_FACTOR;
  return { minutes: (km / URBAN_KMH) * 60, source: 'estimated' };
}

/**
 * Fetch road times between every pair of `points` with one OSRM /table call
 * and cache them. Never throws; without OSRM it does nothing.
 */
export async function warmLegs(pointsIn) {
  const base = osrmUrl();
  if (!base) return 0;
  const seen = new Map();
  for (const p of pointsIn.map(point).filter(Boolean)) {
    seen.set(`${p.lat.toFixed(5)},${p.lng.toFixed(5)}`, p);
  }
  const pts = [...seen.values()].slice(0, TABLE_MAX_POINTS);
  if (pts.length < 2) return 0;
  // Nothing to do when every pair is already fresh.
  const now = Date.now();
  const stale = pts.some((a) => pts.some((b) => a !== b
    && !(legs.get(legKey(a, b))?.at > now - LEG_TTL_MS)));
  if (!stale) return 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    tableStats.tableCalls += 1;
    const coords = pts.map((p) => `${p.lng},${p.lat}`).join(';');
    const res = await fetch(`${base}/table/v1/driving/${coords}?annotations=duration`,
      { signal: controller.signal });
    if (!res.ok) throw new Error(`OSRM table answered ${res.status}`);
    const body = await res.json();
    if (body?.code !== 'Ok' || !Array.isArray(body.durations)) throw new Error(`OSRM table: ${body?.code ?? 'no table'}`);
    // A point snapped far from any road gives confident nonsense; skip its row and column.
    const badSnap = (body.sources ?? []).map((w) => Number(w?.distance) > 500);
    let n = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let k = 0; k < pts.length; k++) {
        const s = body.durations[i]?.[k];
        if (i === k || badSnap[i] || badSnap[k] || !Number.isFinite(s)) continue;
        legs.delete(legKey(pts[i], pts[k]));
        legs.set(legKey(pts[i], pts[k]), { at: now, minutes: s / 60 });
        n += 1;
      }
    }
    while (legs.size > LEG_MAX) legs.delete(legs.keys().next().value);
    tableStats.legsCached = legs.size;
    return n;
  } catch (err) {
    tableStats.tableErrors += 1;
    stats.lastError = err?.name === 'AbortError' ? `OSRM table timed out after ${timeoutMs()} ms` : String(err?.message ?? err);
    stats.lastErrorAt = Date.now();
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget warm, one at a time, for the dispatcher tick. */
export function warmLegsInBackground(points) {
  if (warming || !osrmUrl()) return;
  warming = warmLegs(points).finally(() => { warming = null; });
}

export function legStatus() { return { ...tableStats, legsCached: legs.size }; }

/** Test hook. */
export function resetLegs() { legs.clear(); Object.assign(tableStats, { tableCalls: 0, tableErrors: 0, legsCached: 0 }); }

/**
 * Both legs of a job in one call: driver to store, then store to customer.
 * `driverAt` is optional -- at quote time there is no assigned driver, so the
 * collection leg is priced from a nominal distance the rate card defines.
 */
export async function routeJob({ driverAt, pickup, dropoff, nominalCollectKm = 0.9 }) {
  const delivery = await route(pickup, dropoff);
  const collection = driverAt
    ? await route(driverAt, pickup)
    : { km: nominalCollectKm, minutes: Number(((nominalCollectKm / URBAN_KMH) * 60).toFixed(1)),
        source: 'nominal' };
  return {
    collectKm: collection.km,
    collectMinutes: collection.minutes,
    deliverKm: delivery.km,
    deliverMinutes: delivery.minutes,
    // If either leg fell back, the whole quote is an estimate.
    source: (collection.source === 'osrm' || collection.source === 'nominal')
      && delivery.source === 'osrm' ? 'osrm' : 'estimated',
  };
}
