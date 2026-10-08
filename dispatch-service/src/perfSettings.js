/**
 * The per-order costs that turn CM1 into CM2, set in the back office
 * (Performance tab). Until one is set it counts as zero, and the dashboard
 * says so: a CM2 that leaves out a cost nobody entered looks better than it is.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS perf_settings (
  key        TEXT PRIMARY KEY,
  value      REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
`;

export const COST_SETTINGS = {
  paymentFeePct: { label: 'Payment fee, % of revenue', default: 0, min: 0, max: 20 },
  paymentFeeFixed: { label: 'Payment fee, Rand per order', default: 0, min: 0, max: 50 },
  supportCostPerQuery: { label: 'Support cost, Rand per query handled', default: 0, min: 0, max: 500 },
  usdZar: { label: 'Rand per US dollar (AI photo-check cost)', default: 18.5, min: 1, max: 100 },
};

export class PerfSettings {
  constructor(db) {
    this.sql = db.sql;
    this.sql.exec(SCHEMA);
  }

  /** { values: { key: number }, set: { key: true if someone entered it } } */
  get() {
    const rows = new Map(this.sql.prepare('SELECT key, value, updated_at, updated_by FROM perf_settings').all().map((r) => [r.key, r]));
    const values = {}, set = {};
    for (const [k, def] of Object.entries(COST_SETTINGS)) {
      values[k] = rows.has(k) ? rows.get(k).value : def.default;
      set[k] = rows.has(k);
    }
    return { values, set };
  }

  /** @returns an error message, or null when saved */
  update(patch, actor = 'ops') {
    for (const [k, v] of Object.entries(patch ?? {})) {
      const def = COST_SETTINGS[k];
      if (!def) return `Unknown setting: ${k}`;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < def.min || v > def.max) {
        return `${def.label} must be a number from ${def.min} to ${def.max}.`;
      }
    }
    const up = this.sql.prepare(`INSERT INTO perf_settings (key, value, updated_at, updated_by) VALUES (?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
    for (const [k, v] of Object.entries(patch ?? {})) up.run(k, v, Date.now(), actor);
    return null;
  }
}
