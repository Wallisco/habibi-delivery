// Next job ("chaining"): a driver carrying one collected order is offered one
// next order when they will finish their drop and reach the next store by the
// time its food is ready. Single orders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/server.js';
import { SUPPLY } from '../src/supply.js';
import { CHAIN } from '../src/dispatch.js';

const STORE = { lat: -33.8312, lng: 18.6512, name: 'KFC Milnerton' };
const STORE2 = { lat: -33.8318, lng: 18.6520, name: 'Spur Milnerton' };   // ~100 m away
const near = (m, from = STORE) => ({ lat: from.lat + m / 111000, lng: from.lng, name: `${m} m away` });
const MIN = 60000;

function appFor(t) {
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  return app;
}

async function driver(app, phone = '0821234567') {
  const signin = (await app.inject({ method: 'POST', url: '/v1/driver/signin', payload: { phone, firstName: 'Sipho' } })).json();
  const id = signin.driver.id;
  const headers = { authorization: `Bearer ${signin.token}` };
  for (const d of (await app.inject({ url: `/v1/driver/${id}/account`, headers })).json().requiredDocs) {
    await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/document`, payload: { docKey: d.key, status: 'VERIFIED' } });
  }
  await app.inject({ method: 'PATCH', url: `/v1/ops/accounts/${id}`, payload: { vehicleReg: 'CA 1', zone: 'Milnerton' } });
  await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/onboarding`, payload: { state: 'ACTIVE' } });
  await app.inject({ method: 'POST', url: `/v1/driver/${id}/state`, headers, payload: { state: SUPPLY.ZONE_COMMITTED, zone: 'Milnerton' } });
  await app.inject({ method: 'POST', url: `/v1/driver/${id}/position`, headers, payload: { lat: STORE.lat, lng: STORE.lng } });
  const get = async (url) => (await app.inject({ url, headers })).json();
  return { id, headers, current: () => get('/v1/driver/current'), shift: () => get(`/v1/driver/${id}/shift`) };
}

async function order(app, { pickup = STORE, storeId = 'KFC-MIL', dropoff = near(300), prep = null, now = true } = {}) {
  const res = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId, zone: 'Milnerton', pickup, dropoff, prepMinutes: prep, dispatchNow: now } });
  assert.equal(res.statusCode, 201);
  return res.json().jobId;
}

const accept = (app, jobId, d) => app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/accept`, payload: { driverId: d.id } });

/** The driver takes one order and collects it: food in the box, on the way to the customer. */
async function carrying(app, d, dropoff = near(300)) {
  const jobId = await order(app, { dropoff });
  assert.equal(app.engine.dispatcher.tick(), 1);
  assert.equal((await accept(app, jobId, d)).statusCode, 200);
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/collect` });
  return jobId;
}

test('a driver finishing a drop is offered the next order whose food is ready when they get there', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  const first = await carrying(app, d);

  // About 7 minutes until they could be at Spur (ride 300 m, 5 min at the
  // door, ride back); Spur's food is ready in 10.
  const nextId = await order(app, { pickup: STORE2, storeId: 'SPUR', dropoff: near(600, STORE2), prep: 10, now: false });
  app.engine.dispatcher.tick();
  const offer = (await d.shift()).offer;
  assert.ok(offer, 'offered while still carrying');
  assert.equal(offer.jobId, nextId);
  assert.equal(offer.next.afterJobId, first);
  assert.equal(offer.addsToRun, false, 'a next job never joins the run in the box');
  assert.ok(offer.next.waitAtStoreMinutes <= CHAIN.maxWaitMin);

  const res = (await accept(app, nextId, d)).json();
  assert.deepEqual(res.jobs.map((j) => j.id), [first], 'the run is unchanged');
  assert.equal(res.next.id, nextId);
  assert.equal(app.engine.jobs.get(nextId).status, 'NEXT');

  let cur = await d.current();
  assert.deepEqual(cur.jobs.map((j) => j.id), [first]);
  assert.equal(cur.next.id, nextId);

  // The drop is done: the next job is the driver's job now.
  await app.inject({ method: 'POST', url: `/v1/ops/orders/${first}/close`, payload: { outcome: 'DELIVERED', reason: 'test' } });
  cur = await d.current();
  assert.deepEqual(cur.jobs.map((j) => j.id), [nextId]);
  assert.equal(cur.next, null);
  assert.equal(cur.stage, 'NAVIGATE_STORE');
  assert.equal(app.engine.jobs.get(nextId).status, 'ASSIGNED');
});

test('no next job when the food would be ready before the driver can get there', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  await carrying(app, d);
  // Ready in 2 minutes; the driver is 7 away. An idle driver should take it.
  const nextId = await order(app, { pickup: STORE2, storeId: 'SPUR', dropoff: near(600, STORE2), prep: 2, now: false });
  app.engine.dispatcher.tick();
  assert.equal(app.engine.dispatcher.offers.get(nextId), undefined);
});

test('no next job when the food is so far off the driver would stand waiting', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  await carrying(app, d);
  const nextId = await order(app, { pickup: STORE2, storeId: 'SPUR', dropoff: near(600, STORE2), prep: 30, now: false });
  app.engine.dispatcher.tick();
  assert.equal(app.engine.dispatcher.offers.get(nextId), undefined);
});

test('no next job before the order in the box is collected', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  const first = await order(app);
  app.engine.dispatcher.tick();
  await accept(app, first, d);   // accepted, not collected
  const nextId = await order(app, { pickup: STORE2, storeId: 'SPUR', dropoff: near(600, STORE2), prep: 10, now: false });
  app.engine.dispatcher.tick();
  assert.equal(app.engine.dispatcher.offers.get(nextId)?.chainAfter ?? null, null);
});

test('single orders only: never behind a stacked run', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  const a = await order(app, { dropoff: near(300) });
  const b = await order(app, { dropoff: near(320) });
  assert.equal(app.engine.dispatcher.tick(), 1, 'stacked');
  await accept(app, a, d);
  for (const id of [a, b]) await app.inject({ method: 'POST', url: `/v1/jobs/${id}/collect` });
  const nextId = await order(app, { pickup: STORE2, storeId: 'SPUR', dropoff: near(600, STORE2), prep: 10, now: false });
  app.engine.dispatcher.tick();
  assert.equal(app.engine.dispatcher.offers.get(nextId), undefined);
});

test('single orders only: two waiting orders that stack go to a driver together', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  await carrying(app, d);
  const x = await order(app, { pickup: STORE2, storeId: 'SPUR', dropoff: near(600, STORE2), prep: 10, now: false });
  const y = await order(app, { pickup: STORE2, storeId: 'SPUR', dropoff: near(650, STORE2), prep: 10, now: false });
  // Not yet eligible for an idle driver, but they would stack with each other.
  app.engine.dispatcher.chainPass();
  assert.equal(app.engine.dispatcher.offers.get(x), undefined);
  assert.equal(app.engine.dispatcher.offers.get(y), undefined);
});

test('a drop that runs long hands the next job back for someone else', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  const first = await carrying(app, d);
  const nextId = await order(app, { pickup: STORE2, storeId: 'SPUR', dropoff: near(600, STORE2), prep: 10, now: false });
  app.engine.dispatcher.tick();
  await accept(app, nextId, d);
  assert.equal(app.engine.jobs.get(nextId).status, 'NEXT');

  // Twelve minutes on, the driver is still at the first customer's door.
  app.engine.dispatcher.tick(Date.now() + 12 * MIN);
  const job = app.engine.jobs.get(nextId);
  assert.equal(job.status === 'PENDING' || job.status === 'OFFERED', true, `went back to the pool (${job.status})`);
  assert.notEqual(job.driverId, d.id);
  const cur = await d.current();
  assert.deepEqual(cur.jobs.map((j) => j.id), [first], 'their own delivery is untouched');
  assert.equal(cur.next, null);
  assert.equal(job.history.at(-1).kind === 'HANDED_BACK' || job.history.some((h) => h.kind === 'HANDED_BACK'), true);
});

test('signing a driver out releases their next job', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  await carrying(app, d);
  const nextId = await order(app, { pickup: STORE2, storeId: 'SPUR', dropoff: near(600, STORE2), prep: 10, now: false });
  app.engine.dispatcher.tick();
  await accept(app, nextId, d);
  await app.inject({ method: 'POST', url: `/v1/ops/drivers/${d.id}/sign-out`, payload: { reason: 'test' } });
  assert.equal(app.engine.jobs.get(nextId).status, 'PENDING');
  assert.equal(app.engine.jobs.get(nextId).driverId, null);
});
