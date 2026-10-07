// Stacking: two orders at most, the second ready within 5 minutes of the
// first. Either grouped before anyone is offered them, or added to a driver
// already riding to collect the first ("on the run").
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/server.js';
import { SUPPLY } from '../src/supply.js';

const STORE = { lat: -33.8312, lng: 18.6512, name: 'KFC Milnerton' };
const near = (m) => ({ lat: STORE.lat + m / 111000, lng: STORE.lng, name: `${m} m north` });
const T0 = Date.now() - 20 * 60000;

function appFor(t) {
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  // Same kitchen, known prep: ready times differ only by when orders were placed.
  for (let i = 0; i < 12; i++) app.engine.gate.observe('KFC-MIL', 8, { source: 'print', persist: false });
  return app;
}

async function driver(app, phone) {
  const s = (await app.inject({ method: 'POST', url: '/v1/driver/signin', payload: { phone, firstName: 'Sipho' } })).json();
  const id = s.driver.id;
  const headers = { authorization: `Bearer ${s.token}` };
  for (const d of (await app.inject({ url: `/v1/driver/${id}/account`, headers })).json().requiredDocs) {
    await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/document`, payload: { docKey: d.key, status: 'VERIFIED' } });
  }
  await app.inject({ method: 'PATCH', url: `/v1/ops/accounts/${id}`, payload: { vehicleReg: 'CA 1', zone: 'Milnerton' } });
  await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/onboarding`, payload: { state: 'ACTIVE' } });
  await app.inject({ method: 'POST', url: `/v1/driver/${id}/state`, payload: { state: SUPPLY.ZONE_COMMITTED, zone: 'Milnerton' }, headers });
  await app.inject({ method: 'POST', url: `/v1/driver/${id}/position`, payload: { lat: STORE.lat, lng: STORE.lng }, headers });
  return { id, headers };
}

/** An order placed `minutesAfterT0` after the reference time, dropping `m` metres away. */
async function order(app, minutesAfterT0, m = 300) {
  const res = await app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: {
    storeId: 'KFC-MIL', zone: 'Milnerton', pickup: STORE, dropoff: near(m), dispatchNow: true,
    createdAt: T0 + minutesAfterT0 * 60000 } });
  assert.equal(res.statusCode, 201);
  return res.json().jobId;
}

const accept = (app, jobId, d) => app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/accept`, payload: { driverId: d.id } });
const offerFor = (app, d) => app.engine.pendingOffers.get(d.id);

/* ------------------------------------------------ grouped before offering */

test('three orders waiting together: a run of two, and the third on its own', async (t) => {
  const app = appFor(t);
  const a = await driver(app, '0821111111');
  const b = await driver(app, '0822222222');
  const ids = [await order(app, 0, 300), await order(app, 1, 320), await order(app, 2, 340)];
  assert.equal(app.engine.dispatcher.tick(), 2, 'two offers: a pair and a single');
  const sizes = [offerFor(app, a), offerFor(app, b)].map((o) => o.jobs.length).sort();
  assert.deepEqual(sizes, [1, 2]);
  assert.ok(ids.every((id) => app.engine.jobs.get(id).status === 'OFFERED'));
});

test('orders ready more than 5 minutes apart are not grouped', async (t) => {
  const app = appFor(t);
  const a = await driver(app, '0821111111');
  await order(app, 0);
  await order(app, 6);
  app.engine.dispatcher.tick();
  assert.equal(offerFor(app, a).jobs.length, 1);
});

/* --------------------------------------------------------- on the run */

test('on the run: a second order ready within 5 minutes is offered to the driver already going to the store', async (t) => {
  const app = appFor(t);
  const d = await driver(app, '0821111111');
  const first = await order(app, 0);
  app.engine.dispatcher.tick();
  assert.equal((await accept(app, first, d)).statusCode, 200);

  const second = await order(app, 4, 360);
  assert.equal(app.engine.dispatcher.tick(), 1);
  const offer = offerFor(app, d);
  assert.equal(offer.jobId, second, 'offered to the driver already on the way');
  assert.equal(offer.addsToRun, true);
  assert.equal(offer.summary.runOrders, 2);
  assert.equal(offer.stops.filter((s) => s.kind === 'DROPOFF').length, 2, 'the offer shows the whole trip');

  const res = (await accept(app, second, d)).json();
  assert.deepEqual(res.jobs.map((j) => j.id), [first, second], 'the app gets the whole run back');
  const [j1, j2] = [app.engine.jobs.get(first), app.engine.jobs.get(second)];
  assert.ok(j1.batchId && j1.batchId === j2.batchId, 'one run');
  const s = app.engine.supply.get(d.id);
  assert.equal(s.activeJobId, first, 'the first order stays the anchor');
  assert.equal(s.activeBatchId, j1.batchId);

  const cur = (await app.inject({ url: '/v1/driver/current', headers: d.headers })).json();
  assert.deepEqual(cur.jobs.map((j) => j.id), [first, second]);
  assert.deepEqual(cur.stops.map((x) => x.kind), ['PICKUP', 'DROPOFF', 'DROPOFF']);
  assert.equal(cur.stopIndex, 0);
  const assigned = app.engine.outbound.filter((e) => e.type === 'delivery.assigned').map((e) => e.payload.jobId);
  assert.deepEqual(assigned, [first, second], 'Keychat hears about each order once');
});

test('on the run: not if the second order is ready more than 5 minutes after the first', async (t) => {
  const app = appFor(t);
  const d = await driver(app, '0821111111');
  const first = await order(app, 0);
  app.engine.dispatcher.tick();
  await accept(app, first, d);
  await order(app, 6);
  assert.equal(app.engine.dispatcher.tick(), 0, 'nobody free, and it does not fit the run');
  assert.equal(offerFor(app, d), undefined);
});

test('on the run: not once the first order is collected', async (t) => {
  const app = appFor(t);
  const d = await driver(app, '0821111111');
  // Drop-off 1.5 km away: the driver at the store is not near it, so this is
  // about stacking, not a next job near the drop-off (next-job tests below).
  const first = await order(app, 0, 1500);
  app.engine.dispatcher.tick();
  await accept(app, first, d);
  await app.inject({ method: 'POST', url: `/v1/jobs/${first}/collect` });
  await order(app, 2);
  assert.equal(app.engine.dispatcher.tick(), 0);
});

/* ------------------------------------------------ next job near the drop-off */

/** A driver carrying one collected order, standing `m` metres from its drop-off. */
async function nearDropoff(app, m, { dropoff = 1500 } = {}) {
  const d = await driver(app, '0821111111');
  const first = await order(app, 0, dropoff);
  app.engine.dispatcher.tick();
  await accept(app, first, d);
  await app.inject({ method: 'POST', url: `/v1/jobs/${first}/collect` });
  const drop = app.engine.jobs.get(first).dropoff;
  await app.inject({ method: 'POST', url: `/v1/driver/${d.id}/position`, headers: d.headers,
    payload: { lat: drop.lat - m / 111000, lng: drop.lng } });
  return { d, first, drop };
}

/** An order from a store `m` metres north of point p. */
async function orderFrom(app, p, m, minutes = 3) {
  const store = { lat: p.lat + m / 111000, lng: p.lng, name: `Store ${m} m from the drop-off` };
  const res = await app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: {
    storeId: `S-${m}`, zone: 'Milnerton', pickup: store, dropoff: { lat: store.lat + 0.008, lng: store.lng, name: 'Next customer' },
    dispatchNow: true, createdAt: T0 + minutes * 60000 } });
  return res.json().jobId;
}

test('next job: offered within 400 m of the drop-off, for a store within 2 km of it', async (t) => {
  const app = appFor(t);
  const { d, first, drop } = await nearDropoff(app, 390);
  const next = await orderFrom(app, drop, 1800);
  assert.equal(app.engine.dispatcher.tick(), 1);
  const offer = offerFor(app, d);
  assert.equal(offer.jobId, next);
  assert.equal(offer.chained, true);
  assert.equal(offer.addsToRun, false);
  assert.equal(offer.storeFromDropoffKm, 1.8);
  assert.deepEqual(offer.stops.map((s) => s.kind), ['PICKUP', 'DROPOFF', 'PICKUP', 'DROPOFF'],
    'current order first (already collected), then the next job');

  const res = (await accept(app, next, d)).json();
  assert.equal(res.chained, true);
  assert.deepEqual(res.jobs.map((j) => j.id), [first, next]);
  assert.equal(res.stops[res.stopIndex].kind, 'DROPOFF', 'still on the current drop-off');
  assert.deepEqual(res.stops[res.stopIndex].jobIds, [first]);
  assert.equal(res.stage, 'NAVIGATE_CUSTOMER');
  assert.equal(app.engine.jobs.get(next).chainedAfter, first);
  assert.equal(app.engine.supply.get(d.id).activeJobId, first, 'the current order stays the anchor');
});

test('next job: not at 410 m from the drop-off, nor for a store 2.1 km away', async (t) => {
  const far = appFor(t);
  const a = await nearDropoff(far, 410);
  await orderFrom(far, a.drop, 500);
  assert.equal(far.engine.dispatcher.tick(), 0, 'not yet near the drop-off');

  const app = appFor(t);
  const b = await nearDropoff(app, 100);
  await orderFrom(app, b.drop, 2100);
  assert.equal(app.engine.dispatcher.tick(), 0, 'store too far from the drop-off');
});

test('next job: not on a stale position, and only one at a time', async (t) => {
  const app = appFor(t);
  const { d, drop } = await nearDropoff(app, 100);
  // A position from two minutes ago does not count.
  app.engine.supply.get(d.id).position.at = Date.now() - 120_000;
  await orderFrom(app, drop, 500);
  assert.equal(app.engine.dispatcher.tick(), 0, 'stale position');

  await app.inject({ method: 'POST', url: `/v1/driver/${d.id}/position`, headers: d.headers,
    payload: { lat: drop.lat - 100 / 111000, lng: drop.lng } });
  assert.equal(app.engine.dispatcher.tick(), 1);
  await accept(app, offerFor(app, d).jobId, d);
  await orderFrom(app, drop, 700, 4);
  assert.equal(app.engine.dispatcher.tick(), 0, 'already has a next job');
});

test('next job: after the drop-off the driver goes to the next store; cancelling either order leaves the other', async (t) => {
  const app = appFor(t);
  const { d, first, drop } = await nearDropoff(app, 100);
  const next = await orderFrom(app, drop, 800);
  app.engine.dispatcher.tick();
  await accept(app, next, d);

  // Deliver the current order: the next job is now the run, at its pickup.
  await app.inject({ method: 'POST', url: '/v1/jobs/complete', payload: { jobId: first, grade: 'A', position: drop, gpsTrail: [drop] } });
  let cur = (await app.inject({ url: '/v1/driver/current', headers: d.headers })).json();
  assert.deepEqual(cur.jobs.map((j) => j.id), [next]);
  assert.equal(cur.stopIndex, 0, 'at the next pickup');
  assert.equal(app.engine.supply.get(d.id).activeJobId, next);

  // And the other way round: cancel the current order, keep the next job.
  const app2 = appFor(t);
  const b = await nearDropoff(app2, 100);
  const next2 = await orderFrom(app2, b.drop, 800);
  app2.engine.dispatcher.tick();
  await accept(app2, next2, b.d);
  await app2.inject({ method: 'POST', url: `/v1/ops/orders/${b.first}/close`, payload: { outcome: 'CANCELLED', reason: 'test' } });
  cur = (await app2.inject({ url: `/v1/driver/current?jobs=${b.first},${next2}`, headers: b.d.headers })).json();
  assert.deepEqual(cur.jobs.map((j) => j.id), [next2]);
  assert.deepEqual(cur.ended.map((e) => [e.jobId, e.reason]), [[b.first, 'CANCELLED']]);
  assert.equal(cur.stopIndex, 0);
});

test('on the run: never a third order', async (t) => {
  const app = appFor(t);
  const d = await driver(app, '0821111111');
  const first = await order(app, 0);
  app.engine.dispatcher.tick();
  await accept(app, first, d);
  const second = await order(app, 1);
  app.engine.dispatcher.tick();
  await accept(app, second, d);
  await order(app, 2);
  assert.equal(app.engine.dispatcher.tick(), 0, 'the run is full');
});

/* -------------------------------------------------------------- offers */

test('an offer lasts 45 seconds; a late accept is told the offer expired', async (t) => {
  const app = appFor(t);
  const d = await driver(app, '0821111111');
  const jobId = await order(app, 0);
  const { dispatcher } = app.engine;
  const now = Date.now();
  dispatcher.tick(now);
  const offer = offerFor(app, d);
  assert.ok(Math.abs(offer.expiresAt - now - 45_000) < 50, 'expires 45 s after it was made');

  // Still fine at 44 s ...
  assert.equal(dispatcher.offers.get(jobId).expiresAt - now, 45_000);
  // ... gone after 45 s, whether or not dispatch has tidied up yet.
  dispatcher.now = () => now + 46_000;
  const late = await accept(app, jobId, d);
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().error, 'Offer expired');

  const app2 = appFor(t);
  const d2 = await driver(app2, '0822222222');
  const job2 = await order(app2, 0);
  const t2 = Date.now();
  app2.engine.dispatcher.tick(t2);
  app2.engine.dispatcher.tick(t2 + 46_000);   // dispatch expires it first
  const late2 = await accept(app2, job2, d2);
  assert.equal(late2.json().error, 'Offer expired', 'the reason survives dispatch tidying up');
});

test('an expired offer disappears from the driver\'s shift', async (t) => {
  const app = appFor(t);
  const d = await driver(app, '0821111111');
  await order(app, 0);
  app.engine.dispatcher.tick();
  assert.ok((await app.inject({ url: `/v1/driver/${d.id}/shift`, headers: d.headers })).json().offer);
  app.engine.pendingOffers.get(d.id).expiresAt = Date.now() - 1;
  assert.equal((await app.inject({ url: `/v1/driver/${d.id}/shift`, headers: d.headers })).json().offer, null);
});

test('a driver with an open offer is not sent a second one', async (t) => {
  const app = appFor(t);
  const d = await driver(app, '0821111111');
  const a = await order(app, 0, 300);
  assert.equal(app.engine.dispatcher.tick(), 1);
  await order(app, 30, 300);   // not stackable with the first (ready 30 min later)
  assert.equal(app.engine.dispatcher.tick(), 0);
  assert.equal(offerFor(app, d).jobId, a, 'the first offer is still the one on the phone');
});
