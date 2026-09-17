import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/server.js';

const DBN = { lat: -33.8312, lng: 18.6512 };
const drop = { lat: -33.8087, lng: 18.6512, name: '12 Wellington Rd' };
const tokenOf = (res) => res.json().trackingUrl.split('/track/')[1];

async function newJob(app, extra = {}) {
  return app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'S1', zone: 'Durbanville', pickup: DBN, dropoff: drop, ...extra } });
}

test('tracking link uses a 128-bit token, not the job id', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false });
  t.after(() => app.close());
  const res = await newJob(app);
  const token = tokenOf(res);
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(!res.json().trackingUrl.includes(res.json().jobId));

  assert.equal((await app.inject({ url: `/v1/track/${res.json().jobId}` })).statusCode, 404,
    'the job id no longer opens the tracking view');
  const ok = await app.inject({ url: `/v1/track/${token}` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().jobId, undefined, 'job id not exposed to the customer');
  assert.equal(ok.headers['cache-control'], 'no-store');

  const page = await app.inject({ url: `/track/${token}` });
  assert.equal(page.headers['referrer-policy'], 'no-referrer', 'token must not leak to tile servers');
});

test('every webhook carries the token link', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false });
  t.after(() => app.close());
  const res = await newJob(app);
  const accepted = app.engine.outbound.find((e) => e.type === 'delivery.accepted');
  assert.equal(accepted.payload.trackingUrl, res.json().trackingUrl);
});

test('the partner cannot choose the job id or token', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false });
  t.after(() => app.close());
  const a = await newJob(app, { id: 'JOB-1', trackingToken: 'guessable' });
  assert.notEqual(a.json().jobId, 'JOB-1');
  assert.notEqual(tokenOf(a), 'guessable');
});

test('a finished order hides location, then the link expires', async (t) => {
  process.env.TRACKING_LINK_TTL_MIN = '60';
  const app = build({ dbPath: ':memory:', partnerAuth: false });
  t.after(() => app.close());
  const res = await newJob(app);
  const token = tokenOf(res);
  await app.inject({ method: 'POST', url: `/v1/ops/orders/${res.json().jobId}/close`,
    payload: { outcome: 'DELIVERED' } });

  const after = (await app.inject({ url: `/v1/track/${token}` })).json();
  assert.equal(after.status, 'DELIVERED');
  assert.equal(after.dropoffPosition, null, 'no home coordinates once done');
  assert.equal(after.driverPosition, null);
  assert.equal(after.driver, null);

  app.engine.jobs.get(res.json().jobId).completedAt = Date.now() - 61 * 60000;
  assert.equal((await app.inject({ url: `/v1/track/${token}` })).statusCode, 410);
});
