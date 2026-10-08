// Delivery limits (src/limits.js): 11 km by road at most, the customer pays per
// km after 5 km, no stacking beyond 7 km, and no order on a run more than
// 30 min from ready to drop-off. Without OSRM, road = straight line x 1.4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/server.js';
import { SUPPLY } from '../src/supply.js';
import { canJoin } from '../src/batching.js';
import { customerFee, roadKm, outOfRange, LIMIT_DEFAULTS } from '../src/limits.js';
import { MRD_DEFAULT } from '../src/rates.js';

const STORE = { lat: -33.8312, lng: 18.6512, name: 'KFC Milnerton' };
// `km` kilometres north of the store, as the crow flies.
const north = (km, extraM = 0) => ({ lat: STORE.lat + (km * 1000 + extraM) / 111195, lng: STORE.lng, name: `${km} km north` });
const T0 = Date.now() - 20 * 60000;

function appFor(t) {
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  for (let i = 0; i < 12; i++) app.engine.gate.observe('KFC-MIL', 8, { source: 'print', persist: false });
  return app;
}

const quote = (app, dropoff, zone = 'Milnerton') => app.inject({ method: 'POST', url: '/v1/keychat/quote',
  payload: { storeId: 'KFC-MIL', zone, pickup: STORE, dropoff } });

async function order(app, dropoff, minutesAfterT0 = 0) {
  const res = await app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: {
    storeId: 'KFC-MIL', zone: 'Milnerton', pickup: STORE, dropoff, dispatchNow: true,
    createdAt: T0 + minutesAfterT0 * 60000 } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().jobId;
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

/* ---------------------------------------------------------------- the rules */

test('road km: the road route when we have it, else straight line x 1.4', () => {
  assert.equal(roadKm({ source: 'osrm', deliverKm: 9.3 }, STORE, north(5)), 9.3);
  assert.equal(roadKm({ source: 'estimated', deliverKm: 6.75 }, STORE, north(5)), 7);
});

test('11 km by road is the limit; 7.9 km as the crow flies is inside it', () => {
  assert.equal(outOfRange(11, MRD_DEFAULT), null);
  assert.equal(outOfRange(11.01, MRD_DEFAULT).error, 'out_of_range');
  assert.equal(roadKm(null, STORE, north(7.85)) <= LIMIT_DEFAULTS.maxDeliveryKm, true);
});

test('the customer fee: flat up to 5 km, then the per-km-to-customer rate', () => {
  const card = { ...MRD_DEFAULT };
  assert.deepEqual(customerFee(40, 4.2, card),
    { deliveryFee: 40, baseFee: 40, roadKm: 4.2, includedKm: 5, extraKm: 0, extraKmRate: 1.229, extraKmFee: 0 });
  const f = customerFee(40, 8.4, card);
  assert.equal(f.extraKm, 3.4);
  assert.equal(f.extraKmFee, 4.18);
  assert.equal(f.deliveryFee, 44.18);
});

/* ------------------------------------------------------------- quote / job */

test('a quote within 5 km is the flat fee', async (t) => {
  const app = appFor(t);
  const q = (await quote(app, north(3))).json();
  assert.equal(q.customerCharge.deliveryFee, 40);
  assert.equal(q.customerCharge.extraKm, 0);
  assert.equal(q.routing.roadKm, 4.2);
});

test('a quote past 5 km adds every extra km at the zone rate', async (t) => {
  const app = appFor(t);
  const q = (await quote(app, north(6))).json();
  assert.equal(q.routing.roadKm, 8.4);
  assert.equal(q.customerCharge.extraKm, 3.4);
  assert.equal(q.customerCharge.extraKmRate, 1.229);
  assert.equal(q.customerCharge.deliveryFee, 44.18);
  assert.equal(q.margin, Number((44.18 - q.driverCost.total).toFixed(2)));
});

test('past 11 km by road: quote and job are refused with out_of_range', async (t) => {
  const app = appFor(t);
  const q = await quote(app, north(8));
  assert.equal(q.statusCode, 422);
  assert.equal(q.json().error, 'out_of_range');
  assert.equal(q.json().maxDeliveryKm, 11);
  assert.equal(q.json().deliverKm, 11.2);
  const j = await app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: {
    storeId: 'KFC-MIL', zone: 'Milnerton', pickup: STORE, dropoff: north(8) } });
  assert.equal(j.statusCode, 422);
  assert.equal(app.engine.jobs.all().length, 0, 'no job created');
});

test('the limits are per zone, set on the rate card', async (t) => {
  const app = appFor(t);
  await app.inject({ method: 'PUT', url: '/v1/ops/rates/Tygervalley', payload: { card: { maxDeliveryKm: 15, includedDeliveryKm: 6 } } });
  const q = (await quote(app, north(8), 'Tygervalley')).json();
  assert.equal(q.customerCharge.includedKm, 6);
  assert.equal(q.customerCharge.extraKm, 5.2);
  assert.equal((await quote(app, north(8), 'Milnerton')).statusCode, 422, 'other zones keep 11 km');
});

test('a job keeps our fee when Keychat sends none, and records its road km', async (t) => {
  const app = appFor(t);
  const id = await order(app, north(6));
  const job = app.engine.jobs.get(id);
  assert.equal(job.roadKm, 8.4);
  assert.equal(job.customerCharge, 44.18);
});

test('an address corrected past the limit is refused and the order is unchanged', async (t) => {
  const app = appFor(t);
  const id = await order(app, north(2));
  const res = await app.inject({ method: 'PATCH', url: `/v1/ops/orders/${id}/address`, payload: north(9) });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error, 'out_of_range');
  assert.equal(app.engine.jobs.get(id).dropoff.name, '2 km north');
});

/* ---------------------------------------------------------------- stacking */

test('two orders going past 7 km by road are never stacked', async (t) => {
  const app = appFor(t);
  await driver(app, '0821111111');
  await driver(app, '0822222222');
  await order(app, north(5.2), 0);          // 7.3 km by road
  await order(app, north(5.2, 300), 1);
  const batches = app.engine.dispatcher.formBatches();
  assert.deepEqual(batches.map((b) => b.length), [1, 1]);
  const why = app.engine.dispatcher.explainBatching()[0].reason;
  assert.match(why, /no stacking beyond 7 km/);
});

test('two orders inside 7 km still stack', async (t) => {
  const app = appFor(t);
  await driver(app, '0821111111');
  await order(app, north(4), 0);            // 5.6 km by road
  await order(app, north(4, 300), 1);
  assert.deepEqual(app.engine.dispatcher.formBatches().map((b) => b.length), [2]);
});

test('a run is refused when an order would take over 30 min from ready to drop-off', () => {
  const gate = { predictPrepMinutes: () => 0 };
  const now = Date.now();
  const job = (id, dropoff) => ({ id, storeId: 'S', zone: 'Z', pickup: STORE, dropoff, createdAt: now, roadKm: 3 });
  // Drop-offs within 1 km, but a tight limit makes the second drop too late.
  const a = job('A', north(2)), b = job('B', north(2, 900));
  assert.equal(canJoin([a], b, gate, now).ok, true);
  const res = canJoin([a], b, gate, now, () => ({ maxReadyToDropMin: 8 }));
  assert.equal(res.ok, false);
  assert.match(res.reason, /from ready to drop-off \(limit 8 min\)/);
});

test('a run that drifts past 30 min is unbatched: the later order goes back to dispatch', async (t) => {
  const app = appFor(t);
  const d = await driver(app, '0821111111');
  const first = await order(app, north(2), 0);
  const second = await order(app, north(2, 300), 1);
  assert.equal(app.engine.dispatcher.tick(), 1);
  const offer = app.engine.pendingOffers.get(d.id);
  assert.equal(offer.jobs.length, 2);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/jobs/${first}/accept`, payload: { driverId: d.id } })).statusCode, 200);
  assert.equal(app.engine.jobs.get(second).driverId, d.id);

  // Still close by: nothing changes.
  assert.deepEqual(app.engine.dispatcher.reviewRuns(), []);

  // The driver is now 15 km away and has collected neither order.
  await app.inject({ method: 'POST', url: `/v1/driver/${d.id}/position`, payload: north(15), headers: d.headers });
  const out = app.engine.dispatcher.reviewRuns();
  assert.equal(out.length, 1);
  assert.equal(out[0].jobId, second);
  const back = app.engine.jobs.get(second);
  assert.equal(back.status, 'PENDING');
  assert.equal(back.driverId, null);
  assert.equal(back.history.at(-1).kind, 'UNBATCHED');
  assert.equal(app.engine.jobs.get(first).driverId, d.id, 'the driver keeps the first order');
  assert.equal(app.engine.supply.get(d.id).activeJobId, first);
});

test('nothing is unbatched once both orders are collected', async (t) => {
  const app = appFor(t);
  const d = await driver(app, '0821111111');
  const first = await order(app, north(2), 0);
  const second = await order(app, north(2, 300), 1);
  app.engine.dispatcher.tick();
  await app.inject({ method: 'POST', url: `/v1/jobs/${first}/accept`, payload: { driverId: d.id } });
  for (const id of [first, second]) app.engine.jobs.update(id, { collectedAt: Date.now() });
  await app.inject({ method: 'POST', url: `/v1/driver/${d.id}/position`, payload: north(15), headers: d.headers });
  assert.deepEqual(app.engine.dispatcher.reviewRuns(), []);
  assert.equal(app.engine.jobs.get(second).driverId, d.id);
});
