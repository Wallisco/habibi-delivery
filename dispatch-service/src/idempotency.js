/**
 * Idempotency for partner writes.
 *
 * Keychat sends `Idempotency-Key: <their order id or a UUID>` on
 * POST /v1/keychat/jobs. If the call times out and they retry with the same
 * key, they get the original response back instead of a second job and a
 * second driver.
 *
 *   same key, same body      → the stored response, header idempotent-replayed: true
 *   same key, different body → 422, because that is a bug on their side
 *   same key, still running  → 409, retry in a moment
 *
 * Keys are scoped to the partner (one partner can't replay another's) and kept
 * for 48 hours, longer than any sane retry policy. Only successful responses
 * are stored: a 400 should be fixable and resent under the same key.
 */
import { createHash } from 'node:crypto';

const KEEP_MS = 48 * 3600 * 1000;
export const HEADER = 'idempotency-key';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency (
  partner      TEXT NOT NULL,
  key          TEXT NOT NULL,
  route        TEXT NOT NULL,
  body_hash    TEXT NOT NULL,
  status       INTEGER NOT NULL,
  response     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (partner, key, route)
);
CREATE INDEX IF NOT EXISTS idempotency_created ON idempotency(created_at);
`;

/** Stable hash of a JSON body: key order does not matter. */
export function bodyHash(body) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {});
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canon(body ?? {}))).digest('hex');
}

export class IdempotencyStore {
  constructor(db) {
    this.sql = db.sql;
    this.sql.exec(SCHEMA);
    this.inFlight = new Set();
    this.lastSweep = 0;
  }

  sweep(now = Date.now()) {
    if (now - this.lastSweep < 3600 * 1000) return;
    this.lastSweep = now;
    this.sql.prepare('DELETE FROM idempotency WHERE created_at < ?').run(now - KEEP_MS);
  }

  get(partner, key, route) {
    return this.sql.prepare('SELECT * FROM idempotency WHERE partner = ? AND key = ? AND route = ?').get(partner, key, route) ?? null;
  }

  save(partner, key, route, hash, status, response) {
    this.sql.prepare(`INSERT OR IGNORE INTO idempotency (partner, key, route, body_hash, status, response, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(partner, key, route, hash, status, JSON.stringify(response), Date.now());
  }
}

/**
 * Wrap a Fastify handler so it honours Idempotency-Key.
 * Requests without the header run as before.
 */
export function idempotent(store, route, handler) {
  return async (req, reply) => {
    const key = req.headers[HEADER];
    if (key === undefined) return handler(req, reply);
    const k = String(key).trim();
    if (!k || k.length > 200) {
      return reply.code(400).send({ error: 'Idempotency-Key must be 1 to 200 characters.' });
    }
    const partner = req.partner ?? 'internal';
    const hash = bodyHash(req.body);
    store.sweep();

    const prior = store.get(partner, k, route);
    if (prior) {
      if (prior.body_hash !== hash) {
        return reply.code(422).send({ error: 'This Idempotency-Key was already used with a different request body. Use a new key for a new order.' });
      }
      reply.header('idempotent-replayed', 'true');
      return reply.code(prior.status).send(JSON.parse(prior.response));
    }

    const lock = `${partner}\u0000${k}\u0000${route}`;
    if (store.inFlight.has(lock)) {
      return reply.code(409).header('retry-after', '1').send({ error: 'A request with this Idempotency-Key is still being processed. Retry in a moment.' });
    }
    store.inFlight.add(lock);
    try {
      // Capture what the handler sends, whichever way it sends it.
      let sent = null;
      const origSend = reply.send.bind(reply);
      reply.send = (payload) => { sent = payload; return origSend(payload); };
      const result = await handler(req, reply);
      const payload = sent ?? result;
      const status = reply.statusCode;
      if (status >= 200 && status < 300 && payload !== undefined) {
        store.save(partner, k, route, hash, status, typeof payload === 'string' ? JSON.parse(payload) : payload);
      }
      return result;
    } finally {
      store.inFlight.delete(lock);
    }
  };
}
