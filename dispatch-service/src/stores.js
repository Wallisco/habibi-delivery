/**
 * Per-store settings. Stores exist only as a storeId on orders; this is where
 * a switch for one store lives. Today: the AI check of the collection photo
 * (photoCheck.js), off for every store until the office switches it on.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS store_settings (
  store_id    TEXT PRIMARY KEY,
  photo_check INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);
`;

export class StoreSettings {
  constructor(db) {
    this.sql = db.sql;
    this.sql.exec(SCHEMA);
  }

  photoCheck(storeId) {
    if (!storeId) return false;
    return Boolean(this.sql.prepare('SELECT photo_check FROM store_settings WHERE store_id = ?').get(String(storeId))?.photo_check);
  }

  setPhotoCheck(storeId, on, actor = 'ops') {
    this.sql.prepare(`INSERT INTO store_settings (store_id, photo_check, updated_at, updated_by) VALUES (?,?,?,?)
      ON CONFLICT(store_id) DO UPDATE SET photo_check = excluded.photo_check, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(String(storeId), on ? 1 : 0, Date.now(), actor);
  }

  /** storeId -> { photoCheck, updatedAt, updatedBy } */
  all() {
    return new Map(this.sql.prepare('SELECT * FROM store_settings').all().map((r) =>
      [r.store_id, { photoCheck: Boolean(r.photo_check), updatedAt: r.updated_at, updatedBy: r.updated_by }]));
  }
}
