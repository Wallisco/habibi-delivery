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
