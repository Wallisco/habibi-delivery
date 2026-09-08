/**
 * Supply registry.
 *
 * In production the position index lives in Redis (GEOADD / GEOSEARCH) because
 * at 10% of the country this takes ~500 writes a second against 27,400 order
 * events a day -- a 560:1 ratio. Positions are ephemeral; only the trail of a
 * COMPLETED job needs durability, and that is flushed to Postgres as one row.
 *
 * This in-memory implementation keeps the same interface so the swap is a file
 * change, not a rewrite.
 */

export const SUPPLY = {
  OFFLINE: 'OFFLINE',
  ZONE_COMMITTED: 'ZONE_COMMITTED',
  ROAMING_ELIGIBLE: 'ROAMING_ELIGIBLE',
  ROAMING_ACTIVE: 'ROAMING_ACTIVE',
  RETURNING: 'RETURNING',
};

const EARTH_M = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function metresBetween(a, b) {
  if (!a || !b) return Infinity;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.sin(dLon / 2) ** 2 * Math.cos(rad(a.lat)) * Math.cos(rad(b.lat));
  return 2 * EARTH_M * Math.asin(Math.sqrt(h));
}

/**
 * Travel time without a routing call.
 *
 * Deliberate: routing every dispatch candidate through a maps API would cost
 * roughly R750k a month at 10% national share. Straight-line distance times a
 * learned urban speed factor is accurate enough to RANK candidates, which is
 * all the cost function needs. Real road distance is only called for the
 * driver's own navigation, which deep-links to their phone's maps app for free.
 */
export const URBAN_KMH = 22;
export const DETOUR_FACTOR = 1.35;   // road distance vs straight line

export function travelMinutes(a, b, kmh = URBAN_KMH) {
  const km = (metresBetween(a, b) / 1000) * DETOUR_FACTOR;
  return (km / kmh) * 60;
}

export class SupplyRegistry {
  constructor(db = null) {
    this.drivers = new Map();
    this.db = db;
  }

  hydrate(drivers) {
    for (const d of drivers) this.drivers.set(d.id, d);
    return drivers.length;
  }

  upsert(driverId, patch) {
    const cur = this.drivers.get(driverId) ?? {
      id: driverId,
      state: SUPPLY.OFFLINE,
      position: null,
      zone: null,
      capabilities: [],
      capacity: 3,
      activeJobId: null,
      recentJobs: 0,
      acceptanceRate: 1,
      unsyncedCompletions: 0,
      lastSeen: 0,
    };
    const next = { ...cur, ...patch, lastSeen: Date.now() };
    this.drivers.set(driverId, next);
    // Positions change every few seconds and are deliberately not persisted.
    if (!('position' in patch) || Object.keys(patch).length > 1) {
      this.db?.saveDriver(next);
    }
    return next;
  }

  get(driverId) { return this.drivers.get(driverId); }

  /** Drivers dispatch may consider right now. */
  available({ staleAfterMs = 90_000 } = {}) {
    const now = Date.now();
    return [...this.drivers.values()].filter((d) =>
      d.state !== SUPPLY.OFFLINE
      && d.state !== SUPPLY.ROAMING_ACTIVE
      && !d.activeJobId
      && d.position
      && now - d.lastSeen < staleAfterMs
      && d.unsyncedCompletions < 3);
  }

  acceptsKind(state, kind) {
    if (kind === 'ZONE') {
      return [SUPPLY.ZONE_COMMITTED, SUPPLY.ROAMING_ELIGIBLE, SUPPLY.RETURNING].includes(state);
    }
    if (kind === 'ROAMING') return state === SUPPLY.ROAMING_ELIGIBLE;
    if (kind === 'BACKHAUL') return state === SUPPLY.RETURNING;
    return false;
  }

  /**
   * Zone supply health. One number, three uses: the roaming premium, whether
   * roaming departures are allowed at all, and customer-side promised times.
   */
  supplyRatio(zone, pendingJobs, forecastNext30 = 0) {
    const free = this.available().filter((d) => d.zone === zone).length;
    const demand = pendingJobs + forecastNext30;
    if (demand <= 0) return free > 0 ? 99 : 1;
    return free / demand;
  }

  roamingPremium(ratio) {
    if (ratio < 1.0) return 0;      // zone is short; do not tempt anyone away
    if (ratio < 1.4) return 0.10;
    if (ratio < 2.0) return 0.25;
    return 0.40;
  }
}
