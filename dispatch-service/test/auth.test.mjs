import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/server.js';
import { hashKey, parsePartnerKeys } from '../src/auth.js';

const KEY = 'hbk_test_correct-horse-battery-staple';
const keys = parsePartnerKeys(`keychat-test:${hashKey(KEY).toString('hex')}`);
const body = { storeId: 'S1', zone: 'Durbanville',
  pickup: { lat: -33.83, lng: 18.65 }, dropoff: { lat: -33.81, lng: 18.65 } };

test('partner endpoints refuse a missing or wrong key', async (t) => {
  const app = build({ dbPath: ':memory:', partnerKeys: keys });
  t.after(() => app.close());
  const none = await app.inject({ method: 'POST', url: '/v1/keychat/quote', payload: body });
  assert.equal(none.statusCode, 401);
  const wrong = await app.inject({ method: 'POST', url: '/v1/keychat/quote', payload: body,
    headers: { 'x-api-key': 'hbk_test_nope' } });
  assert.equal(wrong.statusCode, 401);
});

test('a valid key gets through', async (t) => {
  const app = build({ dbPath: ':memory:', partnerKeys: keys });
  t.after(() => app.close());
  const ok = await app.inject({ method: 'POST', url: '/v1/keychat/quote', payload: body,
    headers: { 'x-api-key': KEY } });
  assert.equal(ok.statusCode, 200);
});

test('no keys configured fails closed', async (t) => {
  const app = build({ dbPath: ':memory:', partnerKeys: [] });
  t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/v1/keychat/quote', payload: body,
    headers: { 'x-api-key': KEY } });
  assert.equal(res.statusCode, 401);
});

test('public tracking stays public', async (t) => {
  const app = build({ dbPath: ':memory:', partnerKeys: keys });
  t.after(() => app.close());
  const res = await app.inject({ url: '/v1/track/JOB-nope' });
  assert.equal(res.statusCode, 404, 'not found, not unauthorised');
});

test('malformed PARTNER_API_KEYS is rejected at startup', () => {
  assert.throws(() => parsePartnerKeys('keychat:not-a-hash'));
});
