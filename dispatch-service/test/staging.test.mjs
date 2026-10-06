import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/server.js';

const order = (externalId, extra = {}) => ({ externalId, storeId: 'MILNERTON-GALLERIA', zone: 'Milnerton',
  pickup: { lat: -33.833, lng: 18.531, name: 'Milnerton Galleria' },
  dropoff: { lat: -33.8325, lng: 18.5311, name: '43 Loxton Rd' },
  customerCharge: 40, tip: 10, bagCount: 1, prepMinutes: 8, ...extra });

/** Run the dispatcher and simulator forward in simulated time until done. */
async function runUntil(app, done, { stepMs = 1000, maxMs = 15 * 60 * 1000 } = {}) {
  const { dispatcher, sim } = app.engine;
  const t0 = Date.now();
  for (let t = 0; t <= maxMs; t += stepMs) {
    const now = t0 + t;
    dispatcher.tick(now);
    await sim.step(now);
    if (done()) return t;
  }
  throw new Error('simulation did not finish');
}

function stagingApp(t) {
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false, staging: true });
  t.after(() => app.close());
  return app;
}
const types = (app, jobId) => app.engine.outbound.filter((e) => e.payload?.jobId === jobId).map((e) => e.type);

test('staging: a simulated driver delivers the order through the real endpoints', async (t) => {
  const app = stagingApp(t);
  const res = await app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: order('KC-STG-1', { dispatchNow: true }) });
  assert.equal(res.statusCode, 201);
  const { jobId } = res.json();
  const took = await runUntil(app, () => app.engine.jobs.get(jobId).status === 'DELIVERED');
  assert.deepEqual(types(app, jobId),
    ['delivery.accepted', 'delivery.assigned', 'delivery.collected', 'delivery.code_issued', 'delivery.delivered']);
  assert.ok(took >= 2 * 60 * 1000 && took <= 3 * 60 * 1000, `took ${took / 1000}s, expected ~2–3 min`);
  const collected = app.engine.outbound.find((e) => e.type === 'delivery.collected' && e.payload.jobId === jobId);
  assert.ok(collected.payload.trackingUrl, 'tracking link released on collection');
  const driver = app.engine.accounts.get(app.engine.jobs.get(jobId).driverId);
  assert.match(driver.phone, /^SIM-/);
});

test('staging: SIMFAIL is collected and then fails; SIMSLOW takes about three times as long', async (t) => {
  const app = stagingApp(t);
  const fail = (await app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: order('KC-ORD-1-SIMFAIL', { dispatchNow: true }) })).json().jobId;
  await runUntil(app, () => app.engine.jobs.get(fail).status === 'FAILED');
  assert.deepEqual(types(app, fail), ['delivery.accepted', 'delivery.assigned', 'delivery.collected', 'delivery.failed']);
  const failed = app.engine.outbound.find((e) => e.type === 'delivery.failed');
  assert.equal(failed.payload.actor, 'simulator');

  const slow = (await app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: order('KC-ORD-2-SIMSLOW', { dispatchNow: true }) })).json().jobId;
  const took = await runUntil(app, () => app.engine.jobs.get(slow).status === 'DELIVERED', { stepMs: 2000 });
  assert.ok(took >= 6 * 60 * 1000, `SIMSLOW took ${took / 1000}s`);
});

test('staging: without dispatchNow the order is still released within a minute', async (t) => {
  const app = stagingApp(t);
  const { jobId } = (await app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: order('KC-STG-2', { prepMinutes: 30 }) })).json();
  const assigned = await runUntil(app, () => app.engine.jobs.get(jobId).status !== 'PENDING');
  assert.ok(assigned <= 70 * 1000, `released after ${assigned / 1000}s`);
});

test('staging: the tracking page says TEST; production does not run the simulator', async (t) => {
  const app = stagingApp(t);
  const { jobId } = (await app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: order('KC-STG-3', { dispatchNow: true }) })).json();
  await runUntil(app, () => !!app.engine.jobs.get(jobId).collectedAt);
  const token = app.engine.jobs.get(jobId).trackingToken;
  const tr = await app.inject({ url: `/v1/track/${token}` });
  assert.equal(tr.json().test, true);
  assert.equal((await app.inject({ url: '/health' })).json().env, 'staging');

  const prod = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false, staging: false });
  t.after(() => prod.close());
  assert.equal(prod.engine.sim, null);
});

test('production ignores dispatchNow', async (t) => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => { process.env.NODE_ENV = prev; });
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false, staging: false });
  t.after(() => app.close());
  const { jobId } = (await app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: order('KC-P-1', { dispatchNow: true }) })).json();
  assert.equal(app.engine.jobs.get(jobId).dispatchNow, false);
});
