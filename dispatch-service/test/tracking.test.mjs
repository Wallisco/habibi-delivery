import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/server.js';

const DBN = { lat: -33.8312, lng: 18.6512 };
const drop = { lat: -33.8087, lng: 18.6512, name: '12 Wellington Rd' };
const LINK_EVENTS_BEFORE_COLLECTION = ['delivery.accepted', 'delivery.merchant_ready', 'delivery.assigned'];

async function newJob(app, extra = {}) {
  const res = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'S1', zone: 'Durbanville', pickup: DBN, dropoff: drop, ...extra } });
  const jobId = res.json().jobId;
  return { res, jobId, token: app.engine.jobs.get(jobId).trackingToken };
}
const collect = (app, jobId) => app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/collect` });
const events = (app, type) => app.engine.outbound.filter((e) => e.type === type);

test('no tracking link leaves the service before collection', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  const { res, jobId, token } = await newJob(app);

  assert.equal(res.json().trackingUrl, undefined, 'not in the job creation response');
  await app.inject({ method: 'POST', url: `/v1/keychat/jobs/${jobId}/ready` });
  // Address correction and an agent-issued code before collection: still no link.
  await app.inject({ method: 'PATCH', url: `/v1/ops/orders/${jobId}/address`,
    payload: { lat: -33.81, lng: 18.65, name: '14 Wellington Rd' } });
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/approach` });

  for (const e of app.engine.outbound) {
    assert.ok(!JSON.stringify(e.payload).includes(token), `${e.type} leaked the token before collection`);
    assert.equal(e.payload.trackingUrl, undefined, `${e.type} carried a link before collection`);
  }
  assert.equal((await app.inject({ url: `/v1/track/${token}` })).statusCode, 404,
    'the link does not work before collection either');
  const ops = (await app.inject({ url: `/v1/ops/orders/${jobId}` })).json();
  assert.equal(ops.trackingUrl, null);
  assert.equal(ops.order.trackingToken, null);
});

test('delivery.collected releases the link, exactly once', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  const { jobId, token } = await newJob(app, { externalId: 'KC-1' });

  await collect(app, jobId);
  await collect(app, jobId);   // retried scan
  const collected = events(app, 'delivery.collected');
  assert.equal(collected.length, 1, 'a retried scan must not resend the link');
  assert.equal(collected[0].payload.externalId, 'KC-1');
  assert.match(collected[0].payload.trackingUrl, new RegExp(`/track/${token}$`));
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);

  const ok = await app.inject({ url: `/v1/track/${token}` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().jobId, undefined);
  assert.equal(ok.headers['cache-control'], 'no-store');
  const page = await app.inject({ url: `/track/${token}` });
  assert.equal(page.headers['referrer-policy'], 'no-referrer');

  // After collection, later events may repeat it.
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/approach` });
  assert.equal(events(app, 'delivery.code_issued')[0].payload.trackingUrl, collected[0].payload.trackingUrl);
  for (const type of LINK_EVENTS_BEFORE_COLLECTION) {
    for (const e of events(app, type)) assert.equal(e.payload.trackingUrl, undefined, type);
  }
});

test('the job id never opens tracking', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  const { jobId } = await newJob(app);
  await collect(app, jobId);
  assert.equal((await app.inject({ url: `/v1/track/${jobId}` })).statusCode, 404);
});

test('the partner cannot choose the job id or token', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  const { jobId, token } = await newJob(app, { id: 'JOB-1', trackingToken: 'guessable' });
  assert.notEqual(jobId, 'JOB-1');
  assert.notEqual(token, 'guessable');
});

test('a finished order hides location, then the link expires', async (t) => {
  process.env.TRACKING_LINK_TTL_MIN = '60';
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  const { jobId, token } = await newJob(app);
  await collect(app, jobId);
  await app.inject({ method: 'POST', url: `/v1/ops/orders/${jobId}/close`, payload: { outcome: 'DELIVERED' } });

  const after = (await app.inject({ url: `/v1/track/${token}` })).json();
  assert.equal(after.status, 'DELIVERED');
  assert.equal(after.dropoffPosition, null);
  assert.equal(after.driverPosition, null);
  assert.equal(after.driver, null);

  app.engine.jobs.get(jobId).completedAt = Date.now() - 61 * 60000;
  assert.equal((await app.inject({ url: `/v1/track/${token}` })).statusCode, 410);
});
