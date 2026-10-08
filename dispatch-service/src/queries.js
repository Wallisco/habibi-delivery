/**
 * Customer support queries, logged by the office against the order: what the
 * customer called or wrote about, and any refund. The source of the QA error
 * rate, queries per 100 orders, the perfect order rate, and whether the AI
 * photo check pays for itself.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS support_queries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT,
  store_id   TEXT,
  zone       TEXT,
  type       TEXT NOT NULL,
  channel    TEXT NOT NULL,
  refund     REAL NOT NULL DEFAULT 0,
  note       TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS support_queries_at ON support_queries (created_at);
CREATE INDEX IF NOT EXISTS support_queries_job ON support_queries (job_id);
`;

export const QUERY_TYPES = {
  missing_item: { label: 'Missing item', quality: true },
  wrong_item: { label: 'Wrong item', quality: true },
  damaged: { label: 'Damaged', quality: true },
  late: { label: 'Late', quality: false },
  driver_conduct: { label: 'Driver conduct', quality: false },
  other: { label: 'Other', quality: false },
};
export const QUERY_CHANNELS = { call: 'Call', message: 'Message', email: 'Email' };
/** Missing, wrong or damaged: what a perfect order has none of. */
export const isQuality = (type) => Boolean(QUERY_TYPES[type]?.quality);

const row = (r) => ({ id: r.id, jobId: r.job_id, storeId: r.store_id, zone: r.zone, type: r.type,
  channel: r.channel, refund: r.refund, note: r.note, at: r.created_at, by: r.created_by });

export class SupportQueries {
  constructor(db) {
    this.sql = db.sql;
    this.sql.exec(SCHEMA);
  }

  /** @returns { query } or { error } */
  add({ jobId = null, storeId = null, zone = null, type, channel, refund = 0, note = '', at = Date.now() }, actor = 'ops') {
    if (!QUERY_TYPES[type]) return { error: `type must be one of ${Object.keys(QUERY_TYPES).join(', ')}` };
    if (!QUERY_CHANNELS[channel]) return { error: `channel must be one of ${Object.keys(QUERY_CHANNELS).join(', ')}` };
    const r = Number(refund ?? 0);
    if (!Number.isFinite(r) || r < 0 || r > 100000) return { error: 'refund must be a Rand amount, 0 or more' };
    const res = this.sql.prepare(`INSERT INTO support_queries (job_id, store_id, zone, type, channel, refund, note, created_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(jobId, storeId, zone, type, channel, r, String(note ?? '').slice(0, 500), at, actor);
    return { query: this.get(Number(res.lastInsertRowid)) };
  }

  get(id) {
    const r = this.sql.prepare('SELECT * FROM support_queries WHERE id = ?').get(id);
    return r ? row(r) : null;
  }

  since(sinceMs) {
    return this.sql.prepare('SELECT * FROM support_queries WHERE created_at >= ? ORDER BY created_at DESC').all(sinceMs).map(row);
  }

  forJob(jobId) {
    return this.sql.prepare('SELECT * FROM support_queries WHERE job_id = ? ORDER BY created_at').all(jobId).map(row);
  }

  /** For a query logged by mistake. */
  remove(id) {
    return this.sql.prepare('DELETE FROM support_queries WHERE id = ?').run(id).changes > 0;
  }
}
