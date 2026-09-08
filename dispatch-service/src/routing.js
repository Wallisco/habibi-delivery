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
 *
 *   docker run -p 5000:5000 osrm/osrm-backend osrm-routed --algorithm mld /data/sa.osrm
 *   OSRM_URL=http://localhost:5000 npm start
 *
 * WHEN OSRM IS NOT CONFIGURED
 * Falls back to straight-line distance times a detour factor. That is accurate
 * enough to RANK dispatch candidates, which is all the cost function needs, but
 * it is not accurate enough to bill on. Every quote reports which was used, so
 * a reconciliation dispute can be settled by looking at `distanceSource`.
 */

import { metresBetween, DETOUR_FACTOR, URBAN_KMH } from './supply.js';

const OSRM_URL = process.env.OSRM_URL ?? null;
const TIMEOUT_MS = Number(process.env.OSRM_TIMEOUT_MS ?? 2500);

export const ROUTING_MODE = OSRM_URL ? 'osrm' : 'estimated';

function fallback(from, to) {
  const km = (metresBetween(from, to) / 1000) * DETOUR_FACTOR;
  return {
    km: Number(km.toFixed(2)),
    minutes: Number(((km / URBAN_KMH) * 60).toFixed(1)),
    source: 'estimated',
  };
}

/**
 * Road distance and driving time between two points.
 * Never throws: a routing outage must degrade the price, not drop the order.
 */
export async function route(from, to) {
  if (!from || !to) return { km: 0, minutes: 0, source: 'unknown' };
  if (!OSRM_URL) return fallback(from, to);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const res = await fetch(
      `${OSRM_URL}/route/v1/driving/${coords}?overview=false&alternatives=false`,
      { signal: controller.signal });
    if (!res.ok) return fallback(from, to);
    const body = await res.json();
    const r = body?.routes?.[0];
    if (!r) return fallback(from, to);
    return {
      km: Number((r.distance / 1000).toFixed(2)),
      minutes: Number((r.duration / 60).toFixed(1)),
      source: 'osrm',
    };
  } catch {
    // Timeout, connection refused, malformed response -- all the same answer.
    return fallback(from, to);
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
