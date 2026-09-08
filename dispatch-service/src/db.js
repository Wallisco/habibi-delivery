/**
 * Persistence.
 *
 * SQLite via Node's built-in `node:sqlite` — no install, no service, one file
 * on disk. That is deliberate for the testing phase: the whole point is that
 * the service survives a restart without anyone having to run a database.
 *
 * WHAT IS PERSISTED
 *   drivers          identity, zone, supply state, acceptance rate
 *   jobs             full lifecycle, including proof grade and timestamps
 *   evidence         completion bundles, including the GPS trail
 *   prep_samples     ready-gate observations — the most valuable table here
 *
 * WHAT IS NOT
 *   driver positions. They are ephemeral and high-volume: roughly 500 writes a
 *   second at 10% national share, against 27,400 order events a day. Writing
 *   them to durable storage would need a database ten times the size for no
 *   benefit. They stay in memory here and belong in Redis in production; only
 *   the trail of a COMPLETED job is written, as one row, as evidence.
 *
 * MOVING TO POSTGRES
 * Every statement below is plain SQL. Swap `DatabaseSync` for a pg pool, change
 * `?` placeholders to `$1`, and `INTEGER PRIMARY KEY` to `BIGSERIAL`. Nothing
 * outside this file touches the database.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS drivers (
  id              TEXT PRIMARY KEY,
  phone           TEXT,
  zone            TEXT,
  state           TEXT NOT NULL DEFAULT 'OFFLINE',
  capabilities    TEXT NOT NULL DEFAULT '[]',
  capacity        INTEGER NOT NULL DEFAULT 3,
  recent_jobs     INTEGER NOT NULL DEFAULT 0,
  acceptance_rate REAL NOT NULL DEFAULT 1.0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  external_id   TEXT,
  kind          TEXT NOT NULL,
  vertical      TEXT NOT NULL,
  status        TEXT NOT NULL,
  zone          TEXT,
  store_id      TEXT NOT NULL,
  driver_id     TEXT,
  payload       TEXT NOT NULL,      -- full job object as JSON
  created_at    INTEGER NOT NULL,
  promise_at    INTEGER,
  ready_at      INTEGER,
  collected_at  INTEGER,
  completed_at  INTEGER,
  proof_grade   TEXT,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_store  ON jobs(store_id);

CREATE TABLE IF NOT EXISTS evidence (
  id           INTEGER PRIMARY KEY,
  job_id       TEXT NOT NULL,
  grade        TEXT NOT NULL,
  flagged      INTEGER NOT NULL DEFAULT 0,
  payout_held  INTEGER NOT NULL DEFAULT 0,
  bundle       TEXT NOT NULL,       -- position, trail, code, photo ref
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_job ON evidence(job_id);

-- The training data for the ready gate. If you keep one table from this
-- service, keep this one: neither Uber Eats nor Mr D collects it.
CREATE TABLE IF NOT EXISTS prep_samples (
  id           INTEGER PRIMARY KEY,
  store_id     TEXT NOT NULL,
  prep_minutes REAL NOT NULL,
  source       TEXT NOT NULL,       -- 'print' (uncensored) | 'scan'
  observed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS prep_store ON prep_samples(store_id, observed_at);

-- One rate card per zone. Every change is a new row, so a driver disputing a
-- payslip can be answered with the card that was live at the time.
CREATE TABLE IF NOT EXISTS rate_cards (
  id         INTEGER PRIMARY KEY,
  zone       TEXT NOT NULL,
  card       TEXT NOT NULL,
  actor      TEXT NOT NULL DEFAULT 'ops',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_zone ON rate_cards(zone, created_at);

-- Scheduled surge windows per zone. Versioned like rate cards.
CREATE TABLE IF NOT EXISTS surge_windows (
  id         INTEGER PRIMARY KEY,
  zone       TEXT NOT NULL,
  windows    TEXT NOT NULL,
  actor      TEXT NOT NULL DEFAULT 'ops',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS surge_zone ON surge_windows(zone, created_at);

-- Everything we owe Keychat. A stuck row here is an order they have not been
-- billed for, so it must survive a restart and be visible to ops.
CREATE TABLE IF NOT EXISTS outbound_events (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbound_status ON outbound_events(status, created_at);

-- Driver accounts. Separate from the live supply registry: this is who they
-- are and whether they are cleared to work, not where they are right now.
CREATE TABLE IF NOT EXISTS accounts (
  driver_id   TEXT PRIMARY KEY,
  phone       TEXT UNIQUE,
  payload     TEXT NOT NULL,
  onboarding  TEXT NOT NULL,
  hub_code    TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS accounts_onboarding ON accounts(onboarding);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  driver_id  TEXT NOT NULL,
  from_side  TEXT NOT NULL,
  actor      TEXT,
  body       TEXT NOT NULL,
  job_id     TEXT,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE INDEX IF NOT EXISTS messages_driver ON messages(driver_id, created_at);

-- Every movement on a driver's vehicle account. Append only: a balance is
-- derived from the rows, never stored, so a dispute can always be answered
-- with "here is what you were charged and when".
CREATE TABLE IF NOT EXISTS ledger (
  id         TEXT PRIMARY KEY,
  driver_id  TEXT NOT NULL,
  type       TEXT NOT NULL,
  amount     REAL NOT NULL,
  note       TEXT,
  day        TEXT NOT NULL,
  ref        TEXT,
  actor      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_driver ON ledger(driver_id, created_at);
-- One accrual per driver per day, enforced by the database rather than by
-- remembering to check. A restart mid-shift must not double-charge anyone.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_accrual_day
  ON ledger(driver_id, day) WHERE type = 'ACCRUAL';
`;

export class Db {
  constructor(path = './data/dispatch.db') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec('PRAGMA journal_mode = WAL');   // survives an ungraceful stop
    this.sql.exec('PRAGMA foreign_keys = ON');
    this.sql.exec(SCHEMA);
    this.path = path;
  }

  /* ------------------------------------------------------------- drivers */

  saveDriver(d) {
    this.sql.prepare(`
      INSERT INTO drivers (id, phone, zone, state, capabilities, capacity,
                           recent_jobs, acceptance_rate, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        phone=excluded.phone, zone=excluded.zone, state=excluded.state,
        capabilities=excluded.capabilities, capacity=excluded.capacity,
        recent_jobs=excluded.recent_jobs, acceptance_rate=excluded.acceptance_rate,
        updated_at=excluded.updated_at
    `).run(d.id, d.phone ?? null, d.zone ?? null, d.state ?? 'OFFLINE',
      JSON.stringify(d.capabilities ?? []), d.capacity ?? 3,
      d.recentJobs ?? 0, d.acceptanceRate ?? 1, d.createdAt ?? Date.now(), Date.now());
  }

  loadDrivers() {
    return this.sql.prepare('SELECT * FROM drivers').all().map((r) => ({
      id: r.id,
      phone: r.phone,
      zone: r.zone,
      // A driver is never restored as online. The app re-announces its state
      // on reconnect; assuming otherwise would have dispatch offering jobs to
      // someone who closed the app hours ago.
      state: 'OFFLINE',
      capabilities: JSON.parse(r.capabilities),
      capacity: r.capacity,
      recentJobs: r.recent_jobs,
      acceptanceRate: r.acceptance_rate,
      position: null,
      activeJobId: null,
      unsyncedCompletions: 0,
      lastSeen: 0,
    }));
  }

  /* ---------------------------------------------------------------- jobs */

  saveJob(j) {
    this.sql.prepare(`
      INSERT INTO jobs (id, external_id, kind, vertical, status, zone, store_id,
                        driver_id, payload, created_at, promise_at, ready_at,
                        collected_at, completed_at, proof_grade, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, driver_id=excluded.driver_id,
        payload=excluded.payload, ready_at=excluded.ready_at,
        collected_at=excluded.collected_at, completed_at=excluded.completed_at,
        proof_grade=excluded.proof_grade, updated_at=excluded.updated_at
    `).run(j.id, j.externalId ?? null, j.kind, j.vertical, j.status,
      j.zone ?? null, j.storeId, j.driverId ?? null, JSON.stringify(j),
      j.createdAt, j.promiseAt ?? null, j.readyAt ?? null,
      j.collectedAt ?? null, j.completedAt ?? null, j.proofGrade ?? null, Date.now());
  }

  /**
   * Restore only what is still live. Delivered jobs stay on disk for reporting
   * but are not reloaded into memory — otherwise the working set grows without
   * bound and every restart gets slower.
   */
  loadOpenJobs() {
    return this.sql.prepare(`
      SELECT payload FROM jobs
      WHERE status NOT IN ('DELIVERED','CANCELLED','FAILED')
      ORDER BY created_at
    `).all().map((r) => {
      const j = JSON.parse(r.payload);
      // An offer in flight when the process died is not still in flight.
      if (j.status === 'OFFERED') j.status = 'PENDING';
      return j;
    });
  }

  /* ------------------------------------------------------------ evidence */

  saveEvidence({ jobId, grade, flagged, payoutHeld, bundle }) {
    this.sql.prepare(`
      INSERT INTO evidence (job_id, grade, flagged, payout_held, bundle, created_at)
      VALUES (?,?,?,?,?,?)
    `).run(jobId, grade, flagged ? 1 : 0, payoutHeld ? 1 : 0,
      JSON.stringify(bundle), Date.now());
  }

  /* --------------------------------------------------------- rate cards */

  saveRateCard(zone, card, actor = 'ops') {
    this.sql.prepare(`
      INSERT INTO rate_cards (zone, card, actor, created_at) VALUES (?,?,?,?)
    `).run(zone, JSON.stringify(card), actor, Date.now());
  }

  /** The latest card per zone. History stays for dispute resolution. */
  loadRateCards() {
    return this.sql.prepare(`
      SELECT zone, card FROM rate_cards
      WHERE id IN (SELECT MAX(id) FROM rate_cards GROUP BY zone)
    `).all().map((r) => ({ zone: r.zone, card: JSON.parse(r.card) }));
  }

  rateHistory(zone, limit = 20) {
    return this.sql.prepare(`
      SELECT card, actor, created_at FROM rate_cards
      WHERE zone = ? ORDER BY created_at DESC LIMIT ?
    `).all(zone, limit).map((r) => ({
      card: JSON.parse(r.card), actor: r.actor, at: r.created_at,
    }));
  }

  saveSurge(zone, windows, actor = 'ops') {
    this.sql.prepare(`
      INSERT INTO surge_windows (zone, windows, actor, created_at) VALUES (?,?,?,?)
    `).run(zone, JSON.stringify(windows), actor, Date.now());
  }

  loadSurge() {
    return this.sql.prepare(`
      SELECT zone, windows FROM surge_windows
      WHERE id IN (SELECT MAX(id) FROM surge_windows GROUP BY zone)
    `).all().map((r) => ({ zone: r.zone, windows: JSON.parse(r.windows) }));
  }

  saveOutboundEvent(e) {
    this.sql.prepare(`
      INSERT INTO outbound_events (id,type,payload,status,attempts,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, attempts=excluded.attempts, updated_at=excluded.updated_at
    `).run(e.id, e.type, JSON.stringify(e.payload), e.status, e.attempts, e.at, Date.now());
  }

  pendingOutbound(limit = 200) {
    return this.sql.prepare(`
      SELECT * FROM outbound_events WHERE status='PENDING' ORDER BY created_at LIMIT ?
    `).all(limit).map((r) => ({
      id: r.id, type: r.type, payload: JSON.parse(r.payload),
      status: r.status, attempts: r.attempts, at: r.created_at,
    }));
  }

  outboundStats() {
    return this.sql.prepare(`
      SELECT status, COUNT(*) n FROM outbound_events GROUP BY status
    `).all().reduce((a, r) => ({ ...a, [r.status]: r.n }), {});
  }

  recentOutbound(limit = 100) {
    return this.sql.prepare(`
      SELECT id,type,status,attempts,created_at,payload FROM outbound_events
      ORDER BY created_at DESC LIMIT ?
    `).all(limit).map((r) => ({
      ...r,
      // Without the payload the console can show that a code was issued but
      // not what it was, which is useless to an agent on the phone.
      payload: (() => { try { return JSON.parse(r.payload); } catch { return null; } })(),
    }));
  }

  /* ------------------------------------------------------------ accounts */

  saveAccount(a) {
    this.sql.prepare(`
      INSERT INTO accounts (driver_id, phone, payload, onboarding, hub_code, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(driver_id) DO UPDATE SET
        phone=excluded.phone, payload=excluded.payload, onboarding=excluded.onboarding,
        hub_code=excluded.hub_code, updated_at=excluded.updated_at
    `).run(a.driverId, a.phone ?? null, JSON.stringify(a), a.onboarding,
      a.hubCode ?? null, a.createdAt, Date.now());
  }

  loadAccounts() {
    return this.sql.prepare('SELECT payload FROM accounts').all()
      .map((r) => JSON.parse(r.payload));
  }

  /* ------------------------------------------------------------ messages */

  saveMessage(m) {
    this.sql.prepare(`
      INSERT INTO messages (id, driver_id, from_side, actor, body, job_id, created_at, read_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET read_at=excluded.read_at
    `).run(m.id, m.driverId, m.from, m.actor ?? null, m.body, m.jobId ?? null, m.at, m.readAt ?? null);
  }

  /** Recent history only. A thread from six months ago helps nobody. */
  loadMessages(sinceMs = Date.now() - 30 * 86400000) {
    return this.sql.prepare(`
      SELECT * FROM messages WHERE created_at >= ? ORDER BY created_at
    `).all(sinceMs).map((r) => ({
      id: r.id, driverId: r.driver_id, from: r.from_side, actor: r.actor,
      body: r.body, jobId: r.job_id, at: r.created_at, readAt: r.read_at,
    }));
  }

  /* -------------------------------------------------------------- ledger */

  saveLedgerEntry(e) {
    try {
      this.sql.prepare(`
        INSERT INTO ledger (id, driver_id, type, amount, note, day, ref, actor, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(e.id, e.driverId, e.type, e.amount, e.note ?? null, e.day,
        e.ref ?? null, e.actor ?? null, e.at);
    } catch (err) {
      // The unique index on (driver_id, day) for accruals will reject a
      // duplicate. That is the index doing its job, not an error.
      if (!String(err.message).includes('UNIQUE')) throw err;
    }
  }

  loadLedger() {
    return this.sql.prepare('SELECT * FROM ledger ORDER BY created_at').all().map((r) => ({
      id: r.id, driverId: r.driver_id, type: r.type, amount: r.amount,
      note: r.note, day: r.day, ref: r.ref, actor: r.actor, at: r.created_at,
    }));
  }

  /* -------------------------------------------------------- prep samples */

  savePrepSample(storeId, prepMinutes, source) {
    this.sql.prepare(`
      INSERT INTO prep_samples (store_id, prep_minutes, source, observed_at)
      VALUES (?,?,?,?)
    `).run(storeId, prepMinutes, source, Date.now());
  }

  /** Replay recent history into the ready gate on boot, oldest first. */
  loadPrepSamples(perStore = 30) {
    const stores = this.sql.prepare(
      'SELECT DISTINCT store_id FROM prep_samples').all();
    const out = [];
    const stmt = this.sql.prepare(`
      SELECT store_id, prep_minutes, source FROM prep_samples
      WHERE store_id = ? ORDER BY observed_at DESC LIMIT ?
    `);
    for (const { store_id } of stores) {
      const rows = stmt.all(store_id, perStore).reverse();
      for (const r of rows) {
        out.push({ storeId: r.store_id, prepMinutes: r.prep_minutes, source: r.source });
      }
    }
    return out;
  }

  stats() {
    const one = (q) => this.sql.prepare(q).get();
    return {
      path: this.path,
      drivers: one('SELECT COUNT(*) n FROM drivers').n,
      jobs: one('SELECT COUNT(*) n FROM jobs').n,
      delivered: one("SELECT COUNT(*) n FROM jobs WHERE status='DELIVERED'").n,
      evidence: one('SELECT COUNT(*) n FROM evidence').n,
      prepSamples: one('SELECT COUNT(*) n FROM prep_samples').n,
    };
  }

  close() { this.sql.close(); }
}
