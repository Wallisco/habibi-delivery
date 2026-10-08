/**
 * How long each driver is online, per day and zone: the hours in "rider drops
 * per hour".
 *
 * Counted from the app's own signals (position and state, every few seconds
 * while online), not from the online switch alone: a driver who closes the
 * app without going offline stops sending, and a gap of more than two minutes
 * is not counted. Added up in memory and written once a minute.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS driver_online (
  driver_id TEXT NOT NULL,
  day       TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
  zone      TEXT NOT NULL DEFAULT '',
  seconds   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (driver_id, day, zone)
);
`;
export const MAX_GAP_MS = 120_000;

export class OnlineTime {
  constructor(db) {
    this.sql = db.sql;
    this.sql.exec(SCHEMA);
    this.last = new Map();      // driverId -> { at, online }
    this.pending = new Map();   // "driver|day|zone" -> seconds not yet written
  }

  /** A signal from the driver's app. `online`: any state but OFFLINE. */
  beat(driverId, { online, zone = null, at = Date.now() }) {
    const prev = this.last.get(driverId);
    this.last.set(driverId, { at, online });
    if (!prev?.online || !online) return;
    const gap = at - prev.at;
    if (gap <= 0 || gap > MAX_GAP_MS) return;
    const key = `${driverId}|${new Date(prev.at).toISOString().slice(0, 10)}|${zone ?? ''}`;
    this.pending.set(key, (this.pending.get(key) ?? 0) + gap / 1000);
  }

  flush() {
    if (!this.pending.size) return 0;
    const up = this.sql.prepare(`INSERT INTO driver_online (driver_id, day, zone, seconds) VALUES (?,?,?,?)
      ON CONFLICT(driver_id, day, zone) DO UPDATE SET seconds = seconds + excluded.seconds`);
    let n = 0;
    for (const [key, secs] of this.pending) {
      const [driverId, day, zone] = key.split('|');
      up.run(driverId, day, zone, Math.round(secs));
      n += 1;
    }
    this.pending.clear();
    return n;
  }

  /** Online hours since `sinceMs` (whole days), optionally in one zone. */
  hours(sinceMs, zone = null) {
    this.flush();
    const day = new Date(sinceMs).toISOString().slice(0, 10);
    const row = zone
      ? this.sql.prepare('SELECT SUM(seconds) s FROM driver_online WHERE day >= ? AND zone = ?').get(day, zone)
      : this.sql.prepare('SELECT SUM(seconds) s FROM driver_online WHERE day >= ?').get(day);
    return (row?.s ?? 0) / 3600;
  }
}
