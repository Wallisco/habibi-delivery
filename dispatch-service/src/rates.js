/**
 * Rate cards.
 *
 * The fee structure mirrors Mr D's line for line, so a driver moving across can
 * read a payslip they already understand and compare it directly. Every value
 * below was derived from 78,891 of their legs (June–July 2026), not guessed:
 *
 *   Collection Base Fee            R6.50   mode, on 99.9% of legs
 *   Per Km Collection Distance     R0.767  median of fee ÷ km
 *   Delivery Base Fee              R21.00  mode, on 99.7% of legs
 *   Per Km Delivery Distance       R1.229  median of fee ÷ km
 *   Per Order Fuel Surcharge       R1.47   mode, on 99.9% of legs
 *   Premium Fee                    R10.00  mode, on 24.3% of legs
 *   Restaurant Delay Fee           R0.75/min, from 5 min, capped at R45
 *
 * Cross-check: those rates reproduce a platform-funded mean of about R36, and
 * Mr D's actual mean is R36.11. The card is right.
 *
 * WHY PER ZONE
 * Supply and demand are local. Tygervalley at 18:00 and the same suburb at
 * 14:00 are different markets, and Milnerton is a different market again. A
 * single national rate either overpays quiet zones or starves busy ones. Each
 * zone gets its own card, editable live from the back office.
 *
 * WHERE THE DYNAMIC PART LIVES
 * The premium fee. Mr D pays a flat R10 on roughly a quarter of legs by some
 * rule we cannot see. We drive it off the measured supply ratio for that zone,
 * so it rises exactly when drivers are scarce and costs nothing when they are
 * not.
 */

/** Mr D's card, as measured. The default every new zone inherits. */
export const MRD_DEFAULT = {
  collectionBaseFee: 6.50,
  perKmCollectionFee: 0.767,
  deliveryBaseFee: 21.00,
  perKmDeliveryFee: 1.229,
  fuelSurchargePerOrder: 1.47,

  // Premium: paid when the zone is short of drivers.
  premiumFee: 10.00,
  premiumSupplyRatio: 1.0,      // below this ratio, premium applies
  premiumMaxMultiplier: 2.5,    // premium can scale up to this in a severe shortage

  // Restaurant delay. Mr D triggers at 5 min but pays on only 3.46% of legs
  // while their couriers wait a median 13.3 — the threshold is nominal. Ours
  // is the same rate and trigger, and it will pay out far more often, which is
  // the point.
  restaurantDelayFreeMinutes: 5,
  restaurantDelayPerMinute: 0.75,
  restaurantDelayCapRands: 45.00,

  // Not in Mr D's card. Added because a two-bag order is materially more work.
  perExtraBagFee: 0.00,

  // --- STACKED ORDERS -------------------------------------------------------
  // A second order on the same run does not repeat the fixed costs: the driver
  // is already at the store and already heading that way. It DOES add distance,
  // a second drop, and possibly a second wait. Pay for the marginal work.
  //
  // Deliberately generous relative to the marginal effort, because a driver who
  // suspects stacking pays them less per order will decline batches -- and the
  // efficiency is worth more to us than the difference.
  stackedDeliveryBaseFee: 12.60,   // 60% of a full delivery base
  stackedCollectionBaseFee: 3.25,  // 50%, only when it is a DIFFERENT store
  stackedFuelSurcharge: 0.75,      // roughly half
  // Waiting is paid in full at every store. Time standing still is time
  // standing still, whether it is the first kitchen or the third.
};

export const RATE_FIELDS = [
  { key: 'collectionBaseFee', label: 'Collection base fee', unit: 'R', mrd: 6.50 },
  { key: 'perKmCollectionFee', label: 'Per km to collection', unit: 'R/km', mrd: 0.767 },
  { key: 'deliveryBaseFee', label: 'Delivery base fee', unit: 'R', mrd: 21.00 },
  { key: 'perKmDeliveryFee', label: 'Per km to customer', unit: 'R/km', mrd: 1.229 },
  { key: 'fuelSurchargePerOrder', label: 'Fuel surcharge', unit: 'R', mrd: 1.47 },
  { key: 'premiumFee', label: 'Premium fee', unit: 'R', mrd: 10.00 },
  { key: 'premiumSupplyRatio', label: 'Premium below supply ratio', unit: '', mrd: null },
  { key: 'premiumMaxMultiplier', label: 'Premium max multiplier', unit: '×', mrd: null },
  { key: 'restaurantDelayFreeMinutes', label: 'Delay free minutes', unit: 'min', mrd: 5 },
  { key: 'restaurantDelayPerMinute', label: 'Delay fee per minute', unit: 'R/min', mrd: 0.75 },
  { key: 'restaurantDelayCapRands', label: 'Delay fee cap', unit: 'R', mrd: 45.00 },
  { key: 'perExtraBagFee', label: 'Per extra bag', unit: 'R', mrd: 0 },
  { key: 'stackedDeliveryBaseFee', label: 'Stacked delivery base', unit: 'R', mrd: null },
  { key: 'stackedCollectionBaseFee', label: 'Stacked collection base', unit: 'R', mrd: null },
  { key: 'stackedFuelSurcharge', label: 'Stacked fuel surcharge', unit: 'R', mrd: null },
];

/**
 * Scheduled surge.
 *
 * Separate from the supply-driven premium and stacked on top of it, because
 * they answer different questions. The premium reacts to a shortage that is
 * happening now. Surge is planned: you know Friday dinner is hard before it
 * arrives, and a driver deciding on Wednesday whether to work Friday needs to
 * see the rate on Wednesday.
 *
 * Defaults come from the demand curve we measured across 92,000 orders:
 * 17:00-19:00 carries roughly 35% of food volume in two of about fourteen
 * trading hours, and Friday carries 22.7% of the week against Monday's 11%.
 */
export const DEFAULT_SURGE = [
  { id: 'dinner-peak', label: 'Dinner peak', days: [0, 1, 2, 3, 4, 5, 6],
    startHour: 17, endHour: 19, bonusRands: 8.00, enabled: true },
  { id: 'friday-night', label: 'Friday night', days: [5],
    startHour: 18, endHour: 21, bonusRands: 6.00, enabled: true },
  { id: 'lunch', label: 'Lunch rush', days: [1, 2, 3, 4, 5],
    startHour: 12, endHour: 13, bonusRands: 4.00, enabled: true },
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export { DAY_NAMES };

export class RateBook {
  constructor(db = null) {
    this.db = db;
    this.byZone = new Map();
    this.default = { ...MRD_DEFAULT };
    this.surgeByZone = new Map();          // zone -> window[]
    this.defaultSurge = DEFAULT_SURGE.map((w) => ({ ...w }));
  }

  hydrate(rows) {
    for (const r of rows) this.byZone.set(r.zone, r.card);
    return rows.length;
  }

  hydrateSurge(rows) {
    for (const r of rows) this.surgeByZone.set(r.zone, r.windows);
    return rows.length;
  }

  /* ------------------------------------------------------------- surge */

  surgeFor(zone) {
    return this.surgeByZone.get(zone) ?? this.defaultSurge;
  }

  setSurge(zone, windows, actor = 'ops') {
    const clean = (windows ?? []).filter((w) => w && w.id).map((w) => ({
      id: String(w.id),
      label: String(w.label ?? w.id),
      days: Array.isArray(w.days) ? w.days.map(Number).filter((d) => d >= 0 && d <= 6) : [],
      startHour: Math.max(0, Math.min(23, Number(w.startHour ?? 0))),
      endHour: Math.max(0, Math.min(24, Number(w.endHour ?? 0))),
      bonusRands: Math.max(0, Number(w.bonusRands ?? 0)),
      enabled: w.enabled !== false,
    }));
    this.surgeByZone.set(zone, clean);
    this.db?.saveSurge(zone, clean, actor);
    return clean;
  }

  /**
   * Surge active at a given moment. endHour is exclusive, so 17-19 covers
   * 17:00 to 18:59 -- which is the two-hour block the data actually shows.
   * Overlapping windows stack; a Friday at 18:00 gets both dinner and Friday
   * night, which is deliberate.
   */
  activeSurge(zone, at = new Date()) {
    const day = at.getDay();
    const hour = at.getHours();
    const hits = this.surgeFor(zone).filter((w) =>
      w.enabled && w.days.includes(day) && hour >= w.startHour && hour < w.endHour);
    return {
      windows: hits.map((w) => ({ id: w.id, label: w.label, bonusRands: w.bonusRands })),
      bonusRands: Number(hits.reduce((a, w) => a + w.bonusRands, 0).toFixed(2)),
    };
  }

  /** The next 24 hours of scheduled surge, so a driver can plan a shift. */
  surgeForecast(zone, from = new Date()) {
    const out = [];
    for (let i = 0; i < 24; i++) {
      const t = new Date(from.getTime() + i * 3600000);
      const s = this.activeSurge(zone, t);
      out.push({
        hour: t.getHours(),
        day: DAY_NAMES[t.getDay()],
        bonusRands: s.bonusRands,
        labels: s.windows.map((w) => w.label),
      });
    }
    return out;
  }

  /** A zone with no card of its own inherits the default. */
  forZone(zone) {
    return { ...this.default, ...(this.byZone.get(zone) ?? {}) };
  }

  /** Only known fields are accepted; a typo must not silently create a rate. */
  setZone(zone, patch, actor = 'ops') {
    const known = new Set(RATE_FIELDS.map((f) => f.key));
    const clean = {};
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (!known.has(k)) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      clean[k] = n;
    }
    const card = { ...this.forZone(zone), ...clean };
    this.byZone.set(zone, card);
    this.db?.saveRateCard(zone, card, actor);
    return card;
  }

  resetZone(zone, actor = 'ops') {
    this.byZone.delete(zone);
    this.db?.saveRateCard(zone, { ...MRD_DEFAULT }, actor);
    return { ...MRD_DEFAULT };
  }

  zones() {
    return [...this.byZone.keys()];
  }

  /**
   * How hard the premium bites right now. Returns 0 when the zone has enough
   * drivers, scaling to premiumMaxMultiplier in a severe shortage.
   */
  premiumMultiplier(zone, supplyRatio) {
    const c = this.forZone(zone);
    if (supplyRatio == null || supplyRatio >= c.premiumSupplyRatio) return 0;
    const shortfall = (c.premiumSupplyRatio - supplyRatio) / c.premiumSupplyRatio;
    return Math.min(c.premiumMaxMultiplier, Number((shortfall * c.premiumMaxMultiplier).toFixed(2)));
  }
}
