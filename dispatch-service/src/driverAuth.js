/**
 * Driver sign-in tokens.
 *
 * Every /v1/driver/* route except sign-in needs `Authorization: Bearer <token>`.
 * The token says who the driver is; a route with a driver id in its path
 * (/v1/driver/:id/...) refuses anyone else's token. That is what lets the back
 * office sign a driver out: revoke the tokens and the phone's next call gets
 * 401, which the app answers by going to sign-in.
 *
 * TOKENS
 * A random 32-byte token. Only its SHA-256 is stored, so a copied database
 * does not hand out live sessions. Thirty days, sliding: a driver who works is
 * never signed out by the clock in the middle of a shift.
 *
 * OLD TOKENS
 * Before this, sign-in handed out `tok_<driverId>` and nothing checked it.
 * Phones still holding one keep working while DRIVER_LEGACY_TOKENS=allow, but
 * only on their own driver's routes, and only until the office signs that
 * driver out. Turn it off once every phone runs a build that signs in again.
 */
import { createHash, randomBytes } from 'node:crypto';

const TOKEN_MS = 30 * 86400 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS driver_tokens (
  token_hash  TEXT PRIMARY KEY,
  driver_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS driver_tokens_driver ON driver_tokens(driver_id);
CREATE TABLE IF NOT EXISTS driver_legacy_revoked (
  driver_id   TEXT PRIMARY KEY,
  at          INTEGER NOT NULL
);
`;

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

export class DriverTokens {
  constructor(db, { now = () => Date.now() } = {}) {
    this.sql = db.sql;
    this.now = now;
    this.sql.exec(SCHEMA);
  }

  issue(driverId) {
    const token = `dt_${randomBytes(32).toString('base64url')}`;
    const now = this.now();
    this.sql.prepare('DELETE FROM driver_tokens WHERE expires_at < ?').run(now);
    this.sql.prepare('INSERT INTO driver_tokens (token_hash, driver_id, created_at, expires_at) VALUES (?,?,?,?)')
      .run(sha(token), String(driverId), now, now + TOKEN_MS);
    return token;
  }

  /** The driver this token belongs to, or null if it is unknown, revoked or expired. */
  driverFor(token) {
    if (!token) return null;
    const now = this.now();
    const r = this.sql.prepare('SELECT * FROM driver_tokens WHERE token_hash = ?').get(sha(token));
    if (!r || r.revoked_at || r.expires_at < now) return null;
    // Sliding expiry, written at most once a minute.
    if (r.expires_at - now < TOKEN_MS - 60000) {
      this.sql.prepare('UPDATE driver_tokens SET expires_at = ? WHERE token_hash = ?').run(now + TOKEN_MS, r.token_hash);
    }
    return r.driver_id;
  }

  /** Sign a driver out everywhere. Returns how many live tokens were revoked. */
  revokeAll(driverId) {
    const now = this.now();
    const r = this.sql.prepare('UPDATE driver_tokens SET revoked_at = ? WHERE driver_id = ? AND revoked_at IS NULL AND expires_at >= ?')
      .run(now, String(driverId), now);
    this.sql.prepare('INSERT OR REPLACE INTO driver_legacy_revoked (driver_id, at) VALUES (?,?)').run(String(driverId), now);
    return Number(r.changes);
  }

  legacyAllowed(driverId) {
    return !this.sql.prepare('SELECT 1 FROM driver_legacy_revoked WHERE driver_id = ?').get(String(driverId));
  }
}

const PUBLIC = new Set(['/v1/driver/signin']);
const bearer = (h) => {
  const m = /^Bearer\s+(\S+)$/i.exec(String(h ?? ''));
  return m ? m[1] : null;
};

/**
 * @param app      Fastify instance
 * @param tokens   DriverTokens
 * @param enabled  false only in unit tests that exercise business logic: the
 *                 /v1/driver/:id/* routes then trust the id in the path, as
 *                 they did before. /v1/driver/current always needs a token.
 * @param legacy   accept old `tok_<driverId>` tokens (see above)
 */
export function registerDriverAuth(app, tokens, {
  enabled = true, legacy = process.env.DRIVER_LEGACY_TOKENS === 'allow',
} = {}) {
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/v1/driver/') || PUBLIC.has(path)) return;
    const pathId = /^\/v1\/driver\/([^/]+)\//.exec(path)?.[1] ?? null;
    const token = bearer(req.headers.authorization);

    let driverId = tokens.driverFor(token);
    if (!driverId && legacy && pathId && token === `tok_${pathId}` && tokens.legacyAllowed(pathId)) {
      driverId = pathId;
    }

    if (!enabled && pathId) { req.driverId = driverId ?? pathId; return; }
    if (!driverId) return reply.code(401).send({ error: 'Sign in again.' });
    if (pathId && pathId !== driverId) return reply.code(403).send({ error: 'That is not your account.' });
    req.driverId = driverId;
  });
}
