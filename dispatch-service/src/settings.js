/**
 * Dispatch settings: the delivery-distance, batching and driver-search rules,
 * set from the back office Settings tab without a deploy.
 *
 * WHERE A VALUE COMES FROM
 *   1. the zone's own setting, if the office set one for that zone
 *   2. else the "All zones" setting (zone '*'), if set
 *   3. else the default below
 * Only overrides are stored, so changing "All zones" reaches every zone that
 * has not been given its own value. Every change is a new row: what was live
 * at any moment can be answered later.
 *
 * WHY NOT ON THE RATE CARD
 * The rate card is saved whole per zone. A rule kept there would be copied
 * into a zone's card on its next pricing save and stop following "All zones".
 */

/** A number from the environment, or the default. Kept for existing servers. */
const env = (name, d) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const ALL_ZONES = '*';

/**
 * Every setting the office can change. `min`/`max` bound what is accepted;
 * `help` is shown beside the field.
 */
export const SETTING_FIELDS = [
  // --- Delivery distance ----------------------------------------------------
  { key: 'maxDeliveryKm', group: 'distance', label: 'Furthest we deliver', unit: 'km by road',
    default: 11, min: 1, max: 50, step: 0.5,
    help: 'Store to customer. Further orders are refused at the quote (out_of_range).' },
  { key: 'includedDeliveryKm', group: 'distance', label: 'Km in the flat delivery fee', unit: 'km by road',
    default: 5, min: 0, max: 50, step: 0.5,
    help: 'Each km after this is added to the customer fee at the zone\'s "Per km to customer" rate (Pricing).' },
  { key: 'roadFactor', group: 'distance', label: 'Road distance from straight line', unit: '×',
    default: 1.4, min: 1, max: 2, step: 0.05,
    help: 'Used when the road route is unavailable: road km = straight-line km × this.' },

  // --- Batching ---------------------------------------------------------------
  { key: 'stackMaxOrders', group: 'batching', label: 'Most orders on one run', unit: 'orders',
    default: env('STACK_MAX_ORDERS', 2), min: 1, max: 3, step: 1,
    help: '1 switches batching off.' },
  { key: 'noStackBeyondKm', group: 'batching', label: 'No batching beyond', unit: 'km by road',
    default: 7, min: 0, max: 50, step: 0.5,
    help: 'An order going further than this always gets its own driver.' },
  { key: 'stackPickupM', group: 'batching', label: 'Pickups within', unit: 'm',
    default: env('STACK_PICKUP_M', 100), min: 0, max: 3000, step: 10,
    help: 'Stores on one run must be this close to each other.' },
  { key: 'stackDropoffM', group: 'batching', label: 'Drop-offs within', unit: 'm',
    default: env('STACK_DROPOFF_M', 1000), min: 0, max: 10000, step: 50,
    help: 'Customers on one run must be this close to each other.' },
  { key: 'stackReadyWindowMin', group: 'batching', label: 'Food ready within', unit: 'min',
    default: 5, min: 0, max: 30, step: 1,
    help: 'A second order joins only if its food is ready this close to the first order\'s.' },
  { key: 'stackMaxExtraMin', group: 'batching', label: 'Most extra minutes per order', unit: 'min',
    default: env('STACK_MAX_EXTRA_MIN', 5), min: 0, max: 30, step: 1,
    help: 'No order may arrive more than this later than it would have alone.' },
  { key: 'maxReadyToDropMin', group: 'batching', label: 'Ready to delivered, on a run', unit: 'min',
    default: 30, min: 10, max: 120, step: 1,
    help: 'No order on a run may take longer from food ready to the customer. A run that falls behind loses its later order to another driver.' },

  // --- Finding a driver -------------------------------------------------------
  { key: 'offerSeconds', group: 'drivers', label: 'Time to accept an offer', unit: 'seconds',
    default: 45, min: 15, max: 120, step: 5,
    help: 'Each extra order on the run adds 5 seconds.' },
  { key: 'searchStartKm', group: 'drivers', label: 'Look for drivers within', unit: 'km of the store',
    default: 6, min: 0.5, max: 30, step: 0.5,
    help: 'Straight line from the driver to the store, when the order is first offered.' },
  { key: 'searchGrowMPerMin', group: 'drivers', label: 'Widen the search by', unit: 'm per minute waiting',
    default: 900, min: 0, max: 5000, step: 50,
    help: 'The search area grows while an order waits for a driver.' },
  { key: 'searchMaxKm', group: 'drivers', label: 'Widest search', unit: 'km of the store',
    default: 15, min: 0.5, max: 50, step: 0.5,
    help: 'The search never grows past this.' },
  { key: 'nextJobMaxWaitMin', group: 'drivers', label: 'Next job: longest wait at the store', unit: 'min',
    default: 8, min: 0, max: 30, step: 1,
    help: 'A driver finishing a drop is offered a next order only if they would not wait longer than this for the food.' },
];

export const SETTING_GROUPS = [
  { key: 'distance', label: 'Delivery distance' },
  { key: 'batching', label: 'Batching' },
  { key: 'drivers', label: 'Finding a driver' },
];

const BY_KEY = new Map(SETTING_FIELDS.map((f) => [f.key, f]));
export const SETTING_DEFAULTS = Object.fromEntries(SETTING_FIELDS.map((f) => [f.key, f.default]));

/**
 * Check a set of values. Returns { values } with numbers, or { errors } naming
 * each field. Cross-field rules are checked on the effective result.
 */
export function validate(patch, current) {
  const errors = {};
  const values = {};
  for (const [k, raw] of Object.entries(patch ?? {})) {
    const f = BY_KEY.get(k);
    if (!f) { errors[k] = 'Unknown setting.'; continue; }
    if (raw === null || raw === '') { values[k] = null; continue; }   // back to inherited
    const n = Number(raw);
    if (!Number.isFinite(n)) { errors[k] = 'Must be a number.'; continue; }
    if (n < f.min || n > f.max) { errors[k] = `Must be between ${f.min} and ${f.max} ${f.unit}.`; continue; }
    if (f.step === 1 && !Number.isInteger(n)) { errors[k] = 'Must be a whole number.'; continue; }
    values[k] = n;
  }
  if (Object.keys(errors).length) return { errors };

  const next = { ...current };
  for (const [k, v] of Object.entries(values)) if (v != null) next[k] = v;
  if (next.includedDeliveryKm > next.maxDeliveryKm) {
    errors.includedDeliveryKm = `Can't be more than the furthest we deliver (${next.maxDeliveryKm} km).`;
  }
  if (next.noStackBeyondKm > next.maxDeliveryKm) {
    errors.noStackBeyondKm = `Can't be more than the furthest we deliver (${next.maxDeliveryKm} km).`;
  }
  if (next.searchStartKm > next.searchMaxKm) {
    errors.searchStartKm = `Can't be more than the widest search (${next.searchMaxKm} km).`;
  }
  return Object.keys(errors).length ? { errors } : { values };
}

export class DispatchSettings {
  constructor(db = null) {
    this.db = db;
    this.byZone = new Map();   // zone ('*' = all zones) -> overrides
  }

  hydrate(rows) {
    for (const r of rows) this.byZone.set(r.zone, r.values);
    return rows.length;
  }

  /** The values in force for a zone, defaults filled in. */
  effective(zone) {
    return { ...SETTING_DEFAULTS, ...(this.byZone.get(ALL_ZONES) ?? {}),
      ...(zone && zone !== ALL_ZONES ? this.byZone.get(zone) ?? {} : {}) };
  }

  /** What a zone inherits if it has no value of its own. */
  inherited(zone) {
    return zone === ALL_ZONES ? { ...SETTING_DEFAULTS } : this.effective(ALL_ZONES);
  }

  overrides(zone) { return { ...(this.byZone.get(zone) ?? {}) }; }

  /**
   * Change some settings for a zone (or '*'). A value of null removes the
   * zone's own value so it follows "All zones" again.
   * @returns {{ settings } | { errors }}
   */
  set(zone, patch, actor = 'ops') {
    const z = zone || ALL_ZONES;
    const res = validate(patch, this.effective(z));
    if (res.errors) return res;
    const own = this.overrides(z);
    for (const [k, v] of Object.entries(res.values)) {
      if (v == null) delete own[k]; else own[k] = v;
    }
    // A change at "All zones" must not leave a zone breaking a cross-field rule.
    if (z === ALL_ZONES) {
      for (const other of this.zones()) {
        const check = validate({}, { ...SETTING_DEFAULTS, ...own, ...this.overrides(other) });
        if (check.errors) {
          return { errors: Object.fromEntries(Object.entries(check.errors)
            .map(([k, m]) => [k, `Zone ${other}: ${m}`])) };
        }
      }
    }
    this.byZone.set(z, own);
    this.db?.saveDispatchSettings(z, own, actor);
    return { settings: this.effective(z) };
  }

  /** Remove every value a zone set of its own. */
  reset(zone, actor = 'ops') {
    this.byZone.delete(zone);
    this.db?.saveDispatchSettings(zone, {}, actor);
    return this.effective(zone);
  }

  zones() { return [...this.byZone.keys()].filter((z) => z !== ALL_ZONES); }
}

/** One setting for one zone, or its default when no lookup is wired. */
export function settingOf(lookup, zone, key) {
  return (lookup ? lookup(zone) : SETTING_DEFAULTS)[key] ?? SETTING_DEFAULTS[key];
}
