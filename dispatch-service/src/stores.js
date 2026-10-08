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

/** off: never; all: every order with items; selective: some orders (photoCheck.js selectForCheck). */
export const PHOTO_MODES = ['off', 'all', 'selective'];

export class StoreSettings {
  constructor(db) {
    this.sql = db.sql;
    this.sql.exec(SCHEMA);
    // Added after the first version: the photo-check mode. A store switched on
    // before it existed keeps checking every order.
    const cols = this.sql.prepare('PRAGMA table_info(store_settings)').all().map((c) => c.name);
    if (!cols.includes('photo_mode')) {
      this.sql.exec("ALTER TABLE store_settings ADD COLUMN photo_mode TEXT NOT NULL DEFAULT 'off'");
      this.sql.exec("UPDATE store_settings SET photo_mode = 'all' WHERE photo_check = 1");
    }
  }

  /** The store's photo-check mode: off, all or selective. */
  photoMode(storeId) {
    if (!storeId) return 'off';
    return this.sql.prepare('SELECT photo_mode FROM store_settings WHERE store_id = ?').get(String(storeId))?.photo_mode ?? 'off';
  }

  /** True when the store checks photos at all (all or selective). */
  photoCheck(storeId) { return this.photoMode(storeId) !== 'off'; }

  /** @param mode  off | all | selective (true = all, false = off) */
  setPhotoMode(storeId, mode, actor = 'ops') {
    const m = mode === true ? 'all' : mode === false ? 'off' : mode;
    if (!PHOTO_MODES.includes(m)) throw new Error(`photoCheck must be one of ${PHOTO_MODES.join(', ')}`);
    this.sql.prepare(`INSERT INTO store_settings (store_id, photo_check, photo_mode, updated_at, updated_by) VALUES (?,?,?,?,?)
      ON CONFLICT(store_id) DO UPDATE SET photo_check = excluded.photo_check, photo_mode = excluded.photo_mode,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(String(storeId), m === 'off' ? 0 : 1, m, Date.now(), actor);
    return m;
  }

  /** Kept for the first version's callers. */
  setPhotoCheck(storeId, on, actor = 'ops') { return this.setPhotoMode(storeId, Boolean(on), actor); }

  /** storeId -> { photoCheck, photoMode, updatedAt, updatedBy } */
  all() {
    return new Map(this.sql.prepare('SELECT * FROM store_settings').all().map((r) =>
      [r.store_id, { photoCheck: r.photo_mode !== 'off', photoMode: r.photo_mode, updatedAt: r.updated_at, updatedBy: r.updated_by }]));
  }
}
