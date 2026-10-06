import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/server.js';
import { hashKey, parsePartnerKeys } from '../src/auth.js';
import { bodyHash } from '../src/idempotency.js';

const KEY = 'hbk_test_idempotency-key-for-tests';
const OTHER = 'hbk_test_another-partner-key-here';
const keys = parsePartnerKeys(`keychat-test:${hashKey(KEY).toString('hex')},other:${hashKey(OTHER).toString('hex')}`);
const order = (extra = {}) => ({ storeId: 'S1', zone: 'Durbanville', externalId: 'KC-1001',
  pickup: { lat: -33.83, lng: 18.65, name: 'Store' }, dropoff: { lat: -33.81, lng: 18.65, name: 'Customer' }, ...extra });

function app(t) {
  const a = build({ dbPath: ':memory:', partnerKeys: keys, opsAuth: false });
  t.after(() => a.close());
  return a;
}
const post = (a, payload, key, apiKey = KEY) => a.inject({ method: 'POST', url: '/v1/keychat/jobs', payload,
  headers: { 'x-api-key': apiKey, ...(key ? { 'idempotency-key': key } : {}) } });

test('body hash ignores key order', () => {
  assert.equal(bodyHash({ a: 1, b: { c: 2, d: 3 } }), bodyHash({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(bodyHash({ a: 1 }), bodyHash({ a: 2 }));
});

test('a retried create with the same key returns the same job, once', async (t) => {
  const a = app(t);
  const first = await post(a, order(), 'KC-1001');
  assert.equal(first.statusCode, 201);
  const again = await post(a, order(), 'KC-1001');
  assert.equal(again.statusCode, 201);
  assert.equal(again.headers['idempotent-replayed'], 'true');
  assert.equal(again.json().jobId, first.json().jobId);
  assert.equal(a.engine.jobs.all().length, 1, 'one job, not two');
  const accepted = a.engine.outbound.filter((e) => e.type === 'delivery.accepted');
  assert.equal(accepted.length, 1, 'one webhook, not two');
});

test('same key with a different body is refused', async (t) => {
  const a = app(t);
  await post(a, order(), 'KC-1001');
  const clash = await post(a, order({ externalId: 'KC-2002' }), 'KC-1001');
  assert.equal(clash.statusCode, 422);
  assert.equal(a.engine.jobs.all().length, 1);
});

test('keys are per partner, and calls without a key behave as before', async (t) => {
  const a = app(t);
  await post(a, order(), 'KC-1001');
  const other = await post(a, order(), 'KC-1001', OTHER);
  assert.equal(other.statusCode, 201);
  assert.notEqual(other.headers['idempotent-replayed'], 'true');
  await post(a, order());
  await post(a, order());
  assert.equal(a.engine.jobs.all().length, 4);
});

test('a failed request can be fixed and resent under the same key', async (t) => {
  const a = app(t);
  const bad = await post(a, { storeId: 'S1' }, 'KC-3003');
  assert.equal(bad.statusCode, 400);
  const good = await post(a, order({ externalId: 'KC-3003' }), 'KC-3003');
  assert.equal(good.statusCode, 201);
});

test('a ready event sent twice counts once', async (t) => {
  const a = app(t);
  const { jobId } = (await post(a, order(), 'KC-1001')).json();
  const ready = () => a.inject({ method: 'POST', url: `/v1/keychat/jobs/${jobId}/ready`, headers: { 'x-api-key': KEY } });
  const before = a.engine.gate.snapshot();
  assert.equal((await ready()).statusCode, 200);
  const second = await ready();
  assert.equal(second.json().duplicate, true);
  assert.equal(a.engine.outbound.filter((e) => e.type === 'delivery.merchant_ready').length, 1);
  assert.ok(before !== undefined);
});
