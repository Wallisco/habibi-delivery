import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/server.js';
import { allowed, hashPassword, verifyPassword } from '../src/opsAuth.js';

const PW = 'correct-horse-battery';

function appWithUsers(t) {
  const app = build({ dbPath: ':memory:', partnerAuth: false });
  t.after(() => app.close());
  const u = app.engine.opsUsers;
  u.add({ email: 'admin@feest.test', name: 'Ada Admin', role: 'admin', password: PW });
  u.add({ email: 'ops@feest.test', name: 'Omar Ops', role: 'ops', password: PW });
  u.add({ email: 'fin@feest.test', name: 'Fay Finance', role: 'finance', password: PW });
  u.add({ email: 'view@feest.test', name: 'Vic Viewer', role: 'viewer', password: PW });
  return app;
}

async function signIn(app, email, password = PW) {
  const res = await app.inject({ method: 'POST', url: '/v1/ops/login', payload: { email, password } });
  const sc = res.headers['set-cookie'];
  return { res, cookie: sc ? String(sc).split(';')[0] : null };
}

test('passwords are salted scrypt and verify', () => {
  const h = hashPassword(PW);
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.notEqual(h, hashPassword(PW));
  assert.ok(verifyPassword(PW, h));
  assert.ok(!verifyPassword('wrong-password', h));
});

test('role rules', () => {
  assert.ok(allowed('viewer', 'GET', '/v1/ops/orders'));
  assert.ok(!allowed('viewer', 'POST', '/v1/ops/orders/j1/close'));
  assert.ok(allowed('ops', 'POST', '/v1/ops/orders/j1/close'));
  assert.ok(!allowed('ops', 'PUT', '/v1/ops/rates/Durbanville'));
  assert.ok(!allowed('ops', 'POST', '/v1/ops/ledger/d1/entry'));
  assert.ok(allowed('finance', 'PUT', '/v1/ops/rates/Durbanville'));
  assert.ok(allowed('finance', 'POST', '/v1/ops/ledger/d1/entry'));
  assert.ok(!allowed('finance', 'POST', '/v1/ops/orders/j1/close'));
  assert.ok(allowed('viewer', 'POST', '/v1/ops/rates/Durbanville/preview'));
  assert.ok(!allowed('ops', 'GET', '/v1/ops/users'));
  assert.ok(allowed('admin', 'PATCH', '/v1/ops/users/2'));
  assert.ok(!allowed('nobody', 'GET', '/v1/ops/orders'));
});

test('the back office is closed without a session', async (t) => {
  const app = appWithUsers(t);
  const page = await app.inject({ url: '/ops' });
  assert.equal(page.statusCode, 302);
  assert.equal(page.headers.location, '/ops/login');
  for (const url of ['/v1/ops/orders', '/v1/ops/accounts', '/v1/ops/ledger', '/v1/ops/rates', '/v1/ops/stats', '/v1/ops/statement']) {
    assert.equal((await app.inject({ url })).statusCode, 401, url);
  }
  const write = await app.inject({ method: 'PUT', url: '/v1/ops/rates/Durbanville', payload: { card: {} } });
  assert.equal(write.statusCode, 401);
  assert.equal((await app.inject({ url: '/ops/login' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200, 'health stays public');
});

test('sign in, use it, sign out', async (t) => {
  const app = appWithUsers(t);
  const bad = await signIn(app, 'ops@feest.test', 'not-the-password');
  assert.equal(bad.res.statusCode, 401);
  assert.equal(bad.cookie, null);

  const { res, cookie } = await signIn(app, 'OPS@feest.test');
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
  const headers = { cookie };

  assert.equal((await app.inject({ url: '/ops', headers })).statusCode, 200);
  const me = await app.inject({ url: '/v1/ops/me', headers });
  assert.equal(me.json().user.role, 'ops');
  assert.equal((await app.inject({ url: '/v1/ops/orders', headers })).statusCode, 200);
  // ops can't change money
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/ops/rates/Durbanville', headers, payload: { card: {} } })).statusCode, 403);
  // a write from another site is refused even with the cookie
  const xs = await app.inject({ method: 'POST', url: '/v1/ops/messages/d1',
    headers: { ...headers, origin: 'https://evil.example', host: 'habibi-api.quikr.co.za' }, payload: { body: 'hi' } });
  assert.equal(xs.statusCode, 403);

  await app.inject({ method: 'POST', url: '/v1/ops/logout', headers });
  assert.equal((await app.inject({ url: '/v1/ops/orders', headers })).statusCode, 401, 'session gone after sign-out');
});

test('the signed-in person is the actor, not whatever the client sends', async (t) => {
  const app = appWithUsers(t);
  const { cookie } = await signIn(app, 'fin@feest.test');
  const res = await app.inject({ method: 'PUT', url: '/v1/ops/rates/Durbanville', headers: { cookie },
    payload: { card: { perKm: 5 }, actor: 'someone-else' } });
  assert.equal(res.statusCode, 200);
  const hist = await app.inject({ url: '/v1/ops/rates/Durbanville/history', headers: { cookie } });
  const text = JSON.stringify(hist.json());
  assert.ok(text.includes('Fay Finance'), text);
  assert.ok(!text.includes('someone-else'));
});

test('staff logins: admin only, and the last admin stays', async (t) => {
  const app = appWithUsers(t);
  const ops = await signIn(app, 'ops@feest.test');
  assert.equal((await app.inject({ url: '/v1/ops/users', headers: { cookie: ops.cookie } })).statusCode, 403);

  const admin = await signIn(app, 'admin@feest.test');
  const headers = { cookie: admin.cookie };
  const list = (await app.inject({ url: '/v1/ops/users', headers })).json();
  assert.equal(list.users.length, 4);
  const adminId = list.users.find((u) => u.role === 'admin').id;
  const demote = await app.inject({ method: 'PATCH', url: `/v1/ops/users/${adminId}`, headers, payload: { role: 'ops' } });
  assert.equal(demote.statusCode, 400);

  const weak = await app.inject({ method: 'POST', url: '/v1/ops/users', headers, payload: { email: 'n@feest.test', name: 'New', role: 'ops', password: 'short' } });
  assert.equal(weak.statusCode, 400);
  const add = await app.inject({ method: 'POST', url: '/v1/ops/users', headers, payload: { email: 'n@feest.test', name: 'New', role: 'ops', password: PW } });
  assert.equal(add.statusCode, 200);

  // deactivating someone ends their session
  const opsId = list.users.find((u) => u.role === 'ops').id;
  await app.inject({ method: 'PATCH', url: `/v1/ops/users/${opsId}`, headers, payload: { active: false } });
  assert.equal((await app.inject({ url: '/v1/ops/orders', headers: { cookie: ops.cookie } })).statusCode, 401);
  assert.equal((await signIn(app, 'ops@feest.test')).res.statusCode, 401);
});

test('repeated failures are slowed down', async (t) => {
  const app = appWithUsers(t);
  for (let i = 0; i < 5; i++) await signIn(app, 'view@feest.test', 'wrong-password-' + i);
  const blocked = await signIn(app, 'view@feest.test');
  assert.equal(blocked.res.statusCode, 429, 'even the right password waits');
});

test('no logins configured means nobody gets in', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false });
  t.after(() => app.close());
  const page = await app.inject({ url: '/ops/login' });
  assert.match(page.body, /No staff logins exist yet/);
  assert.equal((await app.inject({ url: '/v1/ops/orders' })).statusCode, 401);
});
