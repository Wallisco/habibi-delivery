/**
 * Back-office login.
 *
 * Every /v1/ops/* route and the /ops page need a signed-in staff member.
 * Partner (Keychat) and driver routes are untouched: they have their own auth.
 *
 * ROLES (checked on the server, per request — hiding a button is not security)
 *   viewer   read everything, change nothing
 *   ops      run the floor: orders, drivers, documents, messages, codes
 *   finance  read everything; change rates, surge and the driver ledger
 *   admin    everything, plus staff logins
 *
 * SESSIONS
 * A random 32-byte token in an HttpOnly, SameSite=Strict cookie. Only its
 * SHA-256 is stored, so a copied database does not hand out live sessions.
 * Twelve hours, sliding. Writes must also come from this origin.
 *
 * Fails closed: with no staff accounts nobody can sign in. Create the first
 * one on the server with `node scripts/ops-user.js add --email … --role admin`.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { markStaging } from './stagingBanner.js';

export const ROLES = ['viewer', 'ops', 'finance', 'admin'];
export const COOKIE = 'ops_sid';
const SESSION_MS = 12 * 3600 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ops_users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  pass_hash     TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS ops_sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES ops_users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ops_sessions_exp ON ops_sessions(expires_at);
CREATE TABLE IF NOT EXISTS ops_audit (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  method     TEXT,
  path       TEXT,
  status     INTEGER,
  at         INTEGER NOT NULL
);
`;

/* ------------------------------------------------------------ passwords */

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored ?? '').split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = Buffer.from(keyHex, 'hex');
  const test = scryptSync(String(pw), Buffer.from(saltHex, 'hex'), key.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(key, test);
}

export function passwordProblem(pw) {
  const s = String(pw ?? '');
  if (s.length < 10) return 'Use at least 10 characters.';
  if (/^(.)\1+$/.test(s)) return 'Use a password that is not one repeated character.';
  return null;
}

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
// Spent on unknown emails too, so response time does not reveal which exist.
const DUMMY_HASH = hashPassword(randomBytes(12).toString('hex'));

/* ---------------------------------------------------------- permissions */

/** May this role make this request? Pure, so it is unit-tested directly. */
export function allowed(role, method, path) {
  if (!ROLES.includes(role)) return false;
  const p = path.split('?')[0];
  if (p.startsWith('/v1/ops/users')) return role === 'admin';
  const read = method === 'GET' || method === 'HEAD';
  if (read) return true;
  // Previews change nothing: anyone who can see pricing can try a number.
  if (/^\/v1\/ops\/rates\/[^/]+\/preview$/.test(p)) return true;
  if (role === 'admin') return true;
  if (role === 'viewer') return false;
  const money = p.startsWith('/v1/ops/rates') || p.startsWith('/v1/ops/surge') || p.startsWith('/v1/ops/ledger');
  return money ? role === 'finance' : role === 'ops';
}

/* ------------------------------------------------------------- the store */

export class OpsUsers {
  constructor(db) {
    this.sql = db.sql;
    this.sql.exec(SCHEMA);
  }

  count() { return this.sql.prepare('SELECT COUNT(*) n FROM ops_users WHERE active = 1').get().n; }

  list() {
    return this.sql.prepare('SELECT id, email, name, role, active, created_at, last_login_at FROM ops_users ORDER BY name').all()
      .map((r) => ({ id: r.id, email: r.email, name: r.name, role: r.role, active: !!r.active,
        createdAt: r.created_at, lastLoginAt: r.last_login_at }));
  }

  byEmail(email) {
    return this.sql.prepare('SELECT * FROM ops_users WHERE email = ?').get(String(email ?? '').trim().toLowerCase()) ?? null;
  }

  add({ email, name, role, password }) {
    const e = String(email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Enter a valid email address.');
    if (!String(name ?? '').trim()) throw new Error('Enter a name.');
    if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}.`);
    const prob = passwordProblem(password);
    if (prob) throw new Error(prob);
    if (this.byEmail(e)) throw new Error('That email already has a login.');
    const r = this.sql.prepare('INSERT INTO ops_users (email, name, role, pass_hash, created_at) VALUES (?,?,?,?,?)')
      .run(e, String(name).trim(), role, hashPassword(password), Date.now());
    return Number(r.lastInsertRowid);
  }

  update(id, { role, active, password, name } = {}) {
    const u = this.sql.prepare('SELECT * FROM ops_users WHERE id = ?').get(Number(id));
    if (!u) throw new Error('No such login.');
    if (role !== undefined && !ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}.`);
    if (password !== undefined) { const prob = passwordProblem(password); if (prob) throw new Error(prob); }
    const next = { role: role ?? u.role, active: active === undefined ? u.active : (active ? 1 : 0), name: name ? String(name).trim() : u.name };
    // Never lock everyone out: the last active admin stays an active admin.
    if (u.role === 'admin' && u.active && (next.role !== 'admin' || !next.active)) {
      const admins = this.sql.prepare("SELECT COUNT(*) n FROM ops_users WHERE role = 'admin' AND active = 1").get().n;
      if (admins <= 1) throw new Error('Keep at least one active admin.');
    }
    this.sql.prepare('UPDATE ops_users SET role = ?, active = ?, name = ? WHERE id = ?').run(next.role, next.active, next.name, u.id);
    if (password !== undefined) this.sql.prepare('UPDATE ops_users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
    // A changed role, a deactivation or a new password ends every open session.
    if (password !== undefined || next.role !== u.role || !next.active) this.endSessions(u.id);
  }

  /* sessions */
  startSession(userId) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sql.prepare('DELETE FROM ops_sessions WHERE expires_at < ?').run(now);
    this.sql.prepare('INSERT INTO ops_sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
      .run(sha(token), userId, now, now + SESSION_MS);
    this.sql.prepare('UPDATE ops_users SET last_login_at = ? WHERE id = ?').run(now, userId);
    return token;
  }

  userForToken(token) {
    if (!token) return null;
    const now = Date.now();
    const r = this.sql.prepare(`SELECT s.token_hash, s.expires_at, u.id, u.email, u.name, u.role, u.active
      FROM ops_sessions s JOIN ops_users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha(token));
    if (!r || r.expires_at < now || !r.active) return null;
    // Sliding expiry, written at most once a minute.
    if (r.expires_at - now < SESSION_MS - 60000) {
      this.sql.prepare('UPDATE ops_sessions SET expires_at = ? WHERE token_hash = ?').run(now + SESSION_MS, r.token_hash);
    }
    return { id: r.id, email: r.email, name: r.name, role: r.role };
  }

  endSession(token) { if (token) this.sql.prepare('DELETE FROM ops_sessions WHERE token_hash = ?').run(sha(token)); }
  endSessions(userId) { this.sql.prepare('DELETE FROM ops_sessions WHERE user_id = ?').run(userId); }

  audit(userId, action, req, status) {
    this.sql.prepare('INSERT INTO ops_audit (user_id, action, method, path, status, at) VALUES (?,?,?,?,?,?)')
      .run(userId ?? null, action, req?.method ?? null, req ? req.url.split('?')[0] : null, status ?? null, Date.now());
  }

  recentAudit(limit = 200) {
    return this.sql.prepare(`SELECT a.*, u.name FROM ops_audit a LEFT JOIN ops_users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT ?`).all(limit).map((r) => ({ at: r.at, who: r.name ?? null, action: r.action, method: r.method, path: r.path, status: r.status }));
  }
}

/* ------------------------------------------------------------ the hooks */

function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const isOpsPath = (url) => url === '/ops' || url.startsWith('/ops?') || url.startsWith('/v1/ops/');
const PUBLIC_OPS = new Set(['/v1/ops/login', '/v1/ops/logout']);

/**
 * @param app      Fastify instance
 * @param users    OpsUsers
 * @param enabled  false only in unit tests that exercise business logic
 * @param secure   mark the cookie Secure (on behind HTTPS in production)
 * @param staging  show the staging banner on the login page
 */
export function registerOpsAuth(app, users, { enabled = true, secure = process.env.NODE_ENV === 'production', staging = false } = {}) {
  const failures = new Map(); // ip|email -> [timestamps]
  const tooMany = (key) => {
    const now = Date.now();
    const list = (failures.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
    failures.set(key, list);
    return list.length >= LOGIN_MAX_FAILS;
  };
  const fail = (key) => { const l = failures.get(key) ?? []; l.push(Date.now()); failures.set(key, l); };
  const cookie = (value, maxAgeS) =>
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`;

  if (enabled) {
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0];
      if (!isOpsPath(req.url) || PUBLIC_OPS.has(path)) return;
      const user = users.userForToken(readCookie(req.headers.cookie, COOKIE));
      if (!user) {
        if (path === '/ops') return reply.redirect('/ops/login');
        return reply.code(401).send({ error: 'Sign in to the back office.' });
      }
      // Writes must come from our own pages. SameSite=Strict already blocks
      // other sites' cookies; this catches the rest.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        const host = req.headers['x-forwarded-host'] ?? req.headers.host;
        if (origin && host && new URL(origin).host !== host) {
          return reply.code(403).send({ error: 'This request did not come from the back office.' });
        }
      }
      if (!allowed(user.role, req.method, path)) {
        return reply.code(403).send({ error: `Your role (${user.role}) can't do that. Ask an admin.` });
      }
      req.opsUser = user;
    });

    // Whoever is signed in is the actor. A client-sent "actor" is ignored, so
    // the history on rates, documents, codes and closures can't be forged.
    app.addHook('preHandler', async (req) => {
      if (req.opsUser && req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
        req.body.actor = req.opsUser.name;
      }
    });

    app.addHook('onResponse', async (req, reply) => {
      if (req.opsUser && req.method !== 'GET' && req.method !== 'HEAD') {
        try { users.audit(req.opsUser.id, 'request', req, reply.statusCode); } catch { /* never fail a request on audit */ }
      }
    });
  }

  app.get('/ops/login', async (req, reply) => {
    reply.type('text/html').header('cache-control', 'no-store').header('x-frame-options', 'DENY');
    return markStaging(LOGIN_HTML(users.count() === 0), staging);
  });

  app.post('/v1/ops/login', async (req, reply) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const key = `${req.ip}|${email}`;
    if (tooMany(key) || tooMany(req.ip)) {
      return reply.code(429).send({ error: 'Too many attempts. Wait 15 minutes and try again.' });
    }
    const u = users.byEmail(email);
    const ok = verifyPassword(password, u?.pass_hash ?? DUMMY_HASH) && u && u.active;
    if (!ok) {
      fail(key); fail(req.ip);
      users.audit(u?.id ?? null, 'login.failed', req, 401);
      return reply.code(401).send({ error: 'That email and password don\'t match.' });
    }
    failures.delete(key);
    const token = users.startSession(u.id);
    users.audit(u.id, 'login', req, 200);
    reply.header('set-cookie', cookie(token, SESSION_MS / 1000));
    return { ok: true, user: { name: u.name, email: u.email, role: u.role } };
  });

  app.post('/v1/ops/logout', async (req, reply) => {
    users.endSession(readCookie(req.headers.cookie, COOKIE));
    reply.header('set-cookie', cookie('', 0));
    return { ok: true };
  });

  app.get('/v1/ops/me', async (req) => ({ user: req.opsUser ?? null }));

  /* staff logins, admin only (enforced by allowed()) */
  app.get('/v1/ops/users', async () => ({ users: users.list(), roles: ROLES, audit: users.recentAudit(100) }));
  app.post('/v1/ops/users', async (req, reply) => {
    try {
      const id = users.add({ email: req.body?.email, name: req.body?.name, role: req.body?.role, password: req.body?.password });
      return { id };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.patch('/v1/ops/users/:id', async (req, reply) => {
    try {
      users.update(req.params.id, { role: req.body?.role, active: req.body?.active, password: req.body?.password, name: req.body?.name });
      return { ok: true };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });
}

const LOGIN_HTML = (noUsers) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Sign in · Operations</title>
<style>
  :root{--forest:#084A2C;--green:#0F7A46;--mist:#F7FAF8;--ink:#0C1A12;--muted:#647268;--line:#DDE7E1;--red:#C0442F;--redbg:#FBE9E5}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--mist);color:var(--ink);font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
       font-size:15px;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px}
  form{background:#fff;border:1px solid var(--line);border-radius:14px;padding:28px 24px;width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px}
  h1{font-size:22px;font-weight:800;letter-spacing:-.4px}
  .sub{color:var(--muted);font-size:13px;margin-top:-8px}
  label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600;color:var(--muted)}
  input{font:inherit;font-size:16px;padding:10px 12px;border-radius:9px;border:1px solid var(--line);min-height:44px;color:var(--ink)}
  input:focus-visible,button:focus-visible{outline:3px solid var(--green);outline-offset:2px}
  button{font:inherit;font-weight:700;background:var(--green);color:#fff;border:0;border-radius:9px;min-height:44px;cursor:pointer}
  button:disabled{opacity:.6}
  .err{background:var(--redbg);color:var(--red);border-radius:9px;padding:10px 12px;font-size:13px}
  .note{color:var(--muted);font-size:12.5px;line-height:1.5}
  code{font-size:12px}
</style></head><body>
<form id="f" novalidate>
  <h1>Operations</h1><div class="sub">Sign in to the back office</div>
  ${noUsers ? '<div class="err">No staff logins exist yet. On the server run:<br><code>node scripts/ops-user.js add --email you@feest.co.za --name "Your Name" --role admin</code></div>' : ''}
  <label>Email<input id="e" type="email" autocomplete="username" required autofocus></label>
  <label>Password<input id="p" type="password" autocomplete="current-password" required></label>
  <div class="err" id="m" hidden></div>
  <button id="b" type="submit">Sign in</button>
  <p class="note">Forgotten your password? Ask an admin to set a new one.</p>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const b = document.getElementById('b'), m = document.getElementById('m');
  b.disabled = true; m.hidden = true;
  try {
    const r = await fetch('/v1/ops/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: document.getElementById('e').value, password: document.getElementById('p').value }) });
    if (r.ok) { location.href = '/ops'; return; }
    m.textContent = (await r.json().catch(() => ({}))).error || 'Sign-in failed. Try again.';
  } catch { m.textContent = "Can't reach the server. Check your connection and try again."; }
  m.hidden = false; b.disabled = false;
});
</script></body></html>`;
