import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/server.js';
import { Db } from '../src/db.js';
import { DriverTokens } from '../src/driverAuth.js';

const signIn = async (app, phone = '0821234567') => {
  const res = await app.inject({ method: 'POST', url: '/v1/driver/signin', payload: { phone, firstName: 'Test' } });
  assert.equal(res.statusCode, 200);
  return res.json();
};
const auth = (token) => ({ authorization: `Bearer ${token}` });

test('sign-in is public and hands out a random token, stored only as a hash', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false });
  t.after(() => app.close());
  const a = await signIn(app);
  const b = await signIn(app);
  assert.match(a.token, /^dt_[\w-]{40,}$/);
  assert.notEqual(a.token, b.token, 'every sign-in gets its own token');
  assert.ok(!a.token.includes(a.driver.id), 'the token does not contain the driver id');
  const rows = app.engine.db.sql.prepare('SELECT token_hash FROM driver_tokens').all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.token_hash !== a.token && r.token_hash !== b.token && /^[0-9a-f]{64}$/.test(r.token_hash)));
});

test('driver routes need a valid token for that driver', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false });
  t.after(() => app.close());
  const me = await signIn(app, '0821111111');
  const other = await signIn(app, '0822222222');
  const url = `/v1/driver/${me.driver.id}/account`;

  assert.equal((await app.inject({ url })).statusCode, 401, 'no token');
  assert.equal((await app.inject({ url, headers: auth('dt_made-up') })).statusCode, 401, 'unknown token');
  assert.equal((await app.inject({ url, headers: { authorization: me.token } })).statusCode, 401, 'not a Bearer header');
  assert.equal((await app.inject({ url, headers: auth(other.token) })).statusCode, 403, "someone else's token");
  const ok = await app.inject({ url, headers: auth(me.token) });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().driverId, me.driver.id);
});

test('a revoked token is refused on the next call', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false });
  t.after(() => app.close());
  const me = await signIn(app);
  const url = `/v1/driver/${me.driver.id}/messages`;
  assert.equal((await app.inject({ url, headers: auth(me.token) })).statusCode, 200);
  assert.equal(app.engine.driverTokens.revokeAll(me.driver.id), 1);
  const res = await app.inject({ url, headers: auth(me.token) });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'Sign in again.');
  // Signing in again works: sign-out is not a ban.
  const again = await signIn(app);
  assert.equal((await app.inject({ url, headers: auth(again.token) })).statusCode, 200);
});

test('tokens expire after 30 days unused, and slide while used', () => {
  const db = new Db(':memory:');
  let now = Date.UTC(2026, 9, 1);
  const tokens = new DriverTokens(db, { now: () => now });
  const idle = tokens.issue('D1');
  const busy = tokens.issue('D2');
  for (let day = 1; day <= 40; day++) {
    now += 86400000;
    assert.equal(tokens.driverFor(busy), 'D2', `a token used every day still works on day ${day}`);
  }
  assert.equal(tokens.driverFor(idle), null, 'a token unused for 40 days has expired');
  db.close();
});

test('old tok_<id> tokens work only with the flag, only for that driver, and stop after sign-out', async (t) => {
  const strict = build({ dbPath: ':memory:', partnerAuth: false, driverLegacyTokens: false });
  t.after(() => strict.close());
  const s = await signIn(strict);
  assert.equal((await strict.inject({ url: `/v1/driver/${s.driver.id}/account`, headers: auth(`tok_${s.driver.id}`) })).statusCode, 401);

  const app = build({ dbPath: ':memory:', partnerAuth: false, driverLegacyTokens: true });
  t.after(() => app.close());
  const me = await signIn(app, '0821111111');
  const other = await signIn(app, '0822222222');
  const legacy = auth(`tok_${me.driver.id}`);
  assert.equal((await app.inject({ url: `/v1/driver/${me.driver.id}/account`, headers: legacy })).statusCode, 200);
  assert.equal((await app.inject({ url: `/v1/driver/${other.driver.id}/account`, headers: legacy })).statusCode, 401,
    "an old token can't be pointed at another driver");
  assert.equal((await app.inject({ url: '/v1/driver/current', headers: legacy })).statusCode, 401,
    'old tokens never reach the new endpoints');

  app.engine.driverTokens.revokeAll(me.driver.id);
  assert.equal((await app.inject({ url: `/v1/driver/${me.driver.id}/account`, headers: legacy })).statusCode, 401,
    'the office can sign out a phone that still has an old token');
});

test('tokens survive a restart', async (t) => {
  const path = join(mkdtempSync(join(tmpdir(), 'dispatch-auth-')), 'd.db');
  let app = build({ dbPath: path, partnerAuth: false });
  const me = await signIn(app);
  await app.close();

  app = build({ dbPath: path, partnerAuth: false });
  t.after(() => app.close());
  assert.equal((await app.inject({ url: `/v1/driver/${me.driver.id}/account`, headers: auth(me.token) })).statusCode, 200);
});
