import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/server.js';
import { ReadyGate } from '../src/readyGate.js';
import { SUPPLY, metresBetween, travelMinutes } from '../src/supply.js';

/**
 * Sign a driver in and take them all the way through onboarding.
 * Dispatch refuses un-verified drivers, which is the point, so every test that
 * needs a working driver has to do this.
 */
async function onboard(app, phone = '0821234567', zone = 'Durbanville') {
  const res = await app.inject({ method: 'POST', url: '/v1/driver/signin',
    payload: { phone, firstName: 'Test', lastName: 'Driver' } });
  const id = res.json().driver.id;
  const docs = (await app.inject({ url: `/v1/driver/${id}/account` })).json().requiredDocs;
  for (const d of docs) {
    await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/document`,
      payload: { docKey: d.key, status: 'VERIFIED' } });
  }
  await app.inject({ method: 'PATCH', url: `/v1/ops/accounts/${id}`,
    payload: { vehicleReg: 'CA 123-456', zone } });
  await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/onboarding`,
    payload: { state: 'ACTIVE' } });
  return id;
}

const DBN = { lat: -33.8312, lng: 18.6512 };
const near = (m = 300) => ({ lat: DBN.lat + m / 111000, lng: DBN.lng });

/* ------------------------------------------------------------- ready gate */

test('ready gate falls back to a global prior, then learns per store', () => {
  const g = new ReadyGate();
  assert.equal(g.confidence('S1'), 'cold');
  for (let i = 0; i < 20; i++) g.observe('OTHER', 30, { source: 'print' });
  assert.equal(g.confidence('S1'), 'global');
  for (let i = 0; i < 10; i++) g.observe('S1', 12, { source: 'print' });
  assert.equal(g.confidence('S1'), 'store');
  assert.ok(g.predictPrepMinutes('S1') < 15, 'store history should beat the global prior');
});

test('censored observations are rejected, print events are not', () => {
  const g = new ReadyGate();
  assert.equal(g.observe('S1', 20, { source: 'scan', courierWaited: false }), false);
  assert.equal(g.observe('S1', 20, { source: 'scan', courierWaited: true }), true);
  assert.equal(g.observe('S1', 20, { source: 'print', courierWaited: false }), true);
});

test('the gate holds a job back until the food is nearly up', () => {
  const g = new ReadyGate();
  for (let i = 0; i < 12; i++) g.observe('SLOW', 30, { source: 'print' });
  assert.equal(g.isDispatchable('SLOW', 2, 5), false, 'too early at 2 minutes old');
  assert.equal(g.isDispatchable('SLOW', 26, 5), true, 'releases with travel time to spare');
  assert.ok(Math.abs(g.releaseOffsetMinutes('SLOW', 5) - 25) < 0.01);
});

test('queue depth only applies once a store has real history', () => {
  const g = new ReadyGate();
  for (let i = 0; i < 10; i++) g.observe('S1', 20, { source: 'print' });
  assert.equal(g.queueFactor('S1'), 1, 'too thin to condition on');
  for (let i = 0; i < 40; i++) g.observe('S1', 20, { source: 'print' });
  for (let i = 0; i < 8; i++) g.noteOrder('S1');
  assert.ok(g.queueFactor('S1') > 1.2, 'a busy kitchen should be predicted slower');
});

/* --------------------------------------------------------------- geo */

test('travel time uses a detour factor, not straight line', () => {
  const far = { lat: DBN.lat + 0.045, lng: DBN.lng };
  assert.ok(metresBetween(DBN, far) > 4800);
  assert.ok(travelMinutes(DBN, far) > 15, 'roughly 5 km at urban speed');
});

/* ------------------------------------------------------------ end to end */

async function seed(app, { storeId = 'ROCO', prepSamples = 12 } = {}) {
  for (let i = 0; i < prepSamples; i++) {
    app.engine.gate.observe(storeId, 4, { source: 'print' });
  }
  const driverId = await onboard(app);
  await app.inject({ method: 'POST', url: `/v1/driver/${driverId}/state`,
    payload: { state: SUPPLY.ZONE_COMMITTED, zone: 'Durbanville' } });
  await app.inject({ method: 'POST', url: `/v1/driver/${driverId}/position`,
    payload: { lat: DBN.lat, lng: DBN.lng } });
  return driverId;
}

test('a job flows from Keychat to delivered', async (t) => {
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());
  const driverId = await seed(app);

  const quote = await app.inject({ method: 'POST', url: '/v1/keychat/quote',
    payload: { storeId: 'ROCO', zone: 'Durbanville', pickup: DBN, dropoff: near(2500),
      prepMinutes: 12 } });
  assert.equal(quote.statusCode, 200);
  const q = quote.json();

  // What Keychat adds to the customer's order.
  assert.equal(q.customerCharge.deliveryFee, 40);
  // What the delivery will cost us, itemised, so reconciliation is arithmetic.
  assert.ok(q.driverCost.total > 0);
  assert.ok(q.driverCost.lines.some((l) => l.code === 'DELIVERY_BASE'));
  assert.ok(q.driverCost.lines.every((l) => l.code !== 'TIP'),
    'the tip is passed through by Keychat, not a cost we quote');
  assert.equal(q.margin, Number((40 - q.driverCost.total).toFixed(2)));

  // We route it ourselves rather than trusting their number.
  assert.ok(q.routing.deliverKm > 0);
  assert.ok(['osrm', 'estimated'].includes(q.routing.source));

  // The merchant's estimate is reported alongside ours, never instead of it.
  assert.equal(q.timing.merchantPrepMinutes, 12);
  assert.ok(q.timing.ourPrepEstimateMinutes > 0);
  assert.ok(q.timing.driverDispatchAtMinutes >= 0);
  assert.ok(q.timing.etaMinutes > 0);

  const created = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'ROCO', zone: 'Durbanville', pickup: DBN, dropoff: near(2500),
      createdAt: Date.now() - 10 * 60000 } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json().jobId;

  assert.equal(app.engine.dispatcher.tick(), 1, 'the eligible job should be offered');
  const shift = await app.inject({ url: `/v1/driver/${driverId}/shift` });
  assert.equal(shift.json().offer.jobId, jobId);
  assert.equal(shift.json().offer.job.code, undefined, 'the code must never reach the driver');

  const acc = await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/accept`,
    payload: { driverId } });
  assert.equal(acc.statusCode, 200);

  await app.inject({ method: 'POST', url: `/v1/keychat/jobs/${jobId}/ready` });
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/collect` });
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/approach` });

  const issued = app.engine.outbound.find((e) => e.type === 'delivery.code_issued');
  assert.ok(/^\d{4}$/.test(issued.payload.code));

  const tooFar = await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/verify`,
    payload: { code: issued.payload.code, position: { lat: DBN.lat + 0.05, lng: DBN.lng } } });
  assert.equal(tooFar.statusCode, 422);
  assert.equal(tooFar.json().outsideGeofence, true);

  const ok = await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/verify`,
    payload: { code: issued.payload.code, position: near(2500) } });
  assert.equal(ok.statusCode, 200);

  const done = await app.inject({ method: 'POST', url: '/v1/jobs/complete',
    payload: { jobId, grade: 'A', position: near(2500), gpsTrail: [near(2500)] } });
  assert.equal(done.json().accepted, true);
  assert.equal(done.json().payoutHeld, false);
});

test('a wrong code burns an attempt and reports what is left', async (t) => {
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());
  const driverId = await seed(app);
  const created = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'ROCO', zone: 'Durbanville', pickup: DBN, dropoff: near(200),
      createdAt: Date.now() - 10 * 60000 } });
  const jobId = created.json().jobId;
  app.engine.dispatcher.tick();
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/accept`, payload: { driverId } });
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/approach` });

  const bad = await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/verify`,
    payload: { code: '0000', position: near(200) } });
  assert.equal(bad.statusCode, 422);
  assert.equal(bad.json().attemptsLeft, 3);
});

test('proof floor blocks a photo close on an age-restricted order', async (t) => {
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());
  await seed(app);
  const created = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'ROCO', zone: 'Durbanville', pickup: DBN, dropoff: near(200),
      ageRestricted: true } });
  const jobId = created.json().jobId;
  const res = await app.inject({ method: 'POST', url: '/v1/jobs/complete',
    payload: { jobId, grade: 'C', position: near(200) } });
  assert.equal(res.statusCode, 422);
  assert.match(res.json().error, /grade B/);
});

test('an offline completion whose trail never entered the geofence is flagged', async (t) => {
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());
  await seed(app);
  const created = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'ROCO', zone: 'Durbanville', pickup: DBN, dropoff: near(200) } });
  const jobId = created.json().jobId;
  const res = await app.inject({ method: 'POST', url: '/v1/jobs/complete',
    payload: { jobId, grade: 'B', position: near(200),
      gpsTrail: [{ lat: DBN.lat + 0.06, lng: DBN.lng }] } });
  assert.equal(res.json().flagged, true);
  assert.equal(res.json().payoutHeld, true);
});

test('a driver holding a job cannot go offline', async (t) => {
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());
  const driverId = await seed(app);
  const created = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'ROCO', zone: 'Durbanville', pickup: DBN, dropoff: near(200),
      createdAt: Date.now() - 10 * 60000 } });
  app.engine.dispatcher.tick();
  await app.inject({ method: 'POST', url: `/v1/jobs/${created.json().jobId}/accept`,
    payload: { driverId } });
  const res = await app.inject({ method: 'POST', url: `/v1/driver/${driverId}/state`,
    payload: { state: SUPPLY.OFFLINE } });
  assert.equal(res.statusCode, 409);
});

test('a declined offer returns to the pool and is not re-offered to the same driver', async (t) => {
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());
  const driverId = await seed(app);
  const created = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'ROCO', zone: 'Durbanville', pickup: DBN, dropoff: near(200),
      createdAt: Date.now() - 10 * 60000 } });
  const jobId = created.json().jobId;
  app.engine.dispatcher.tick();
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/decline`, payload: { driverId } });
  assert.equal(app.engine.jobs.get(jobId).status, 'PENDING');
  assert.ok(app.engine.supply.get(driverId).acceptanceRate < 1, 'declines are tracked');
  assert.equal(app.engine.dispatcher.tick(), 0, 'no other driver is available');
});

test('the gate suppresses a job that was only just placed', async (t) => {
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());
  await seed(app, { storeId: 'SLOW' });
  for (let i = 0; i < 12; i++) app.engine.gate.observe('SLOW', 32, { source: 'print' });
  await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'SLOW', zone: 'Durbanville', pickup: DBN, dropoff: near(200) } });
  assert.equal(app.engine.dispatcher.tick(), 0, 'held back until the kitchen is nearly done');
});

test('a cold store falls back to the merchant estimate, a known store does not', async (t) => {
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());

  // No history for this store: the merchant's own POS estimate is the prior.
  const cold = await app.inject({ method: 'POST', url: '/v1/keychat/quote',
    payload: { storeId: 'BRAND-NEW', zone: 'Z', pickup: DBN, dropoff: near(2000),
      prepMinutes: 9 } });
  assert.equal(cold.json().timing.prepSource, 'merchant');
  assert.equal(cold.json().timing.ourPrepEstimateMinutes, 9);

  // Once we have measured the store, we trust our own number. Uber's estimate
  // correlated -0.007 with actual readiness across 11,900 orders.
  for (let i = 0; i < 12; i++) {
    app.engine.gate.observe('BRAND-NEW', 22, { source: 'print', persist: false });
  }
  const warm = await app.inject({ method: 'POST', url: '/v1/keychat/quote',
    payload: { storeId: 'BRAND-NEW', zone: 'Z', pickup: DBN, dropoff: near(2000),
      prepMinutes: 9 } });
  assert.equal(warm.json().timing.prepSource, 'store');
  assert.equal(warm.json().timing.ourPrepEstimateMinutes, 22,
    'our measurement must override the merchant estimate');
});

test('a delivered order emits a reconcilable charge to Keychat', async (t) => {
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());

  const created = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'S1', zone: 'Z', pickup: DBN, dropoff: near(2000),
      customerCharge: 40, tip: 15, quoteId: 'Q-abc', externalId: 'KC-1001' } });
  const jobId = created.json().jobId;
  assert.ok(created.json().routing.deliverKm > 0, 'we route on intake');

  await app.inject({ method: 'POST', url: '/v1/jobs/complete',
    payload: { jobId, grade: 'A', position: near(2000), gpsTrail: [near(2000)] } });

  const ev = app.engine.outbound.find((e) => e.type === 'delivery.delivered');
  assert.ok(ev, 'Keychat must be told, or the order never closes and we are never paid');
  assert.equal(ev.payload.externalId, 'KC-1001');
  assert.equal(ev.payload.charge.customerCharge, 40);
  assert.equal(ev.payload.charge.tipPassedThrough, 15);
  assert.equal(ev.payload.charge.margin,
    Number((40 - ev.payload.charge.driverCost).toFixed(2)));

  const st = (await app.inject({ url: '/v1/keychat/statement?days=1' })).json();
  assert.equal(st.orders, 1);
  assert.equal(st.totals.customerCharges, 40);
  assert.equal(st.totals.tipsPassedThrough, 15);
});

test('an un-onboarded driver cannot go online', async (t) => {
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/v1/driver/signin',
    payload: { phone: '0837654321' } });
  const id = res.json().driver.id;
  assert.equal(res.json().driver.canWork, false);

  const online = await app.inject({ method: 'POST', url: `/v1/driver/${id}/state`,
    payload: { state: SUPPLY.ZONE_COMMITTED } });
  assert.equal(online.statusCode, 403,
    'an unvetted person must not be able to carry someone\u2019s dinner');
  assert.equal(online.json().onboarding, 'REGISTERED');
  assert.ok(online.json().outstanding.length > 0);
});

test('activation is refused until every document is verified', async (t) => {
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());
  const id = (await app.inject({ method: 'POST', url: '/v1/driver/signin',
    payload: { phone: '0839999999' } })).json().driver.id;

  const early = await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/onboarding`,
    payload: { state: 'ACTIVE' } });
  assert.equal(early.statusCode, 409);
  assert.match(early.json().error, /not verified/);

  const docs = (await app.inject({ url: `/v1/driver/${id}/account` })).json().requiredDocs;
  for (const d of docs) {
    await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/document`,
      payload: { docKey: d.key, status: 'VERIFIED' } });
  }
  const noVehicle = await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/onboarding`,
    payload: { state: 'ACTIVE' } });
  assert.equal(noVehicle.statusCode, 409, 'still needs a vehicle');

  await app.inject({ method: 'PATCH', url: `/v1/ops/accounts/${id}`,
    payload: { vehicleReg: 'CA 999-000' } });
  const ok = await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/onboarding`,
    payload: { state: 'ACTIVE' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().onboarding, 'ACTIVE');
});

test('driver ids follow the Mr D numeric convention', async (t) => {
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());
  const a = (await app.inject({ method: 'POST', url: '/v1/driver/signin',
    payload: { phone: '0821111111' } })).json().driver.id;
  const b = (await app.inject({ method: 'POST', url: '/v1/driver/signin',
    payload: { phone: '0822222222' } })).json().driver.id;
  assert.match(a, /^\d{6}$/, 'six digit numeric, like 129105 in their exports');
  assert.equal(Number(b), Number(a) + 1);

  // Signing in again must return the same account, not a second one.
  const again = (await app.inject({ method: 'POST', url: '/v1/driver/signin',
    payload: { phone: '0821111111' } })).json().driver.id;
  assert.equal(again, a);
});

test('ops and driver can message each other, with unread tracking', async (t) => {
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());
  const id = await onboard(app, '0824444444');

  await app.inject({ method: 'POST', url: `/v1/ops/messages/${id}`,
    payload: { body: 'Are you still at the restaurant?', actor: 'sarah' } });
  let thread = (await app.inject({ url: `/v1/driver/${id}/messages` })).json();
  assert.equal(thread.unread, 1);
  assert.equal(thread.messages[0].from, 'ops');
  assert.equal(thread.messages[0].actor, 'sarah');

  await app.inject({ method: 'POST', url: `/v1/driver/${id}/messages/read` });
  thread = (await app.inject({ url: `/v1/driver/${id}/messages` })).json();
  assert.equal(thread.unread, 0);

  await app.inject({ method: 'POST', url: `/v1/driver/${id}/messages`,
    payload: { body: 'Yes, they say five more minutes' } });
  const inbox = (await app.inject({ url: '/v1/ops/messages' })).json();
  assert.equal(inbox.inbox[0].driverId, id);
  assert.equal(inbox.inbox[0].awaitingOpsReply, true);
});

test('an order exposes a full state timeline and a customer tracking link', async (t) => {
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());
  const driverId = await seed(app);

  const created = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'ROCO', zone: 'Durbanville', pickup: DBN, dropoff: near(300),
      customerCharge: 40, tip: 12, createdAt: Date.now() - 10 * 60000 } });
  const jobId = created.json().jobId;

  app.engine.dispatcher.tick();
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/accept`, payload: { driverId } });
  await app.inject({ method: 'POST', url: `/v1/keychat/jobs/${jobId}/ready` });
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/collect` });
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/approach` });

  // The code event carries the tracking link Keychat shows the customer.
  const issued = app.engine.outbound.find((e) => e.type === 'delivery.code_issued');
  assert.match(issued.payload.trackingUrl, /\/track\//);

  const detail = (await app.inject({ url: `/v1/ops/orders/${jobId}` })).json();
  const codes = detail.timeline.map((t) => t.code);
  assert.deepEqual(codes.slice(0, 3), ['PENDING', 'OFFERED', 'ASSIGNED']);
  assert.ok(codes.includes('AT_STORE') && codes.includes('IN_TRANSIT'));
  assert.ok(detail.timeline[0].dwellMinutes != null, 'dwell time shows where the delay was');
  assert.ok(detail.order.orderNumber.startsWith('DFD'), 'Mr D order number format');

  // The public view must not leak the driver.
  const pub = (await app.inject({ url: `/v1/track/${jobId}` })).json();
  assert.equal(pub.driver.firstName, 'Test');
  assert.equal(pub.driver.lastName, undefined, 'no surname to the customer');
  assert.equal(pub.driver.phone, undefined, 'no phone number to the customer');
  assert.ok(pub.timeline.length > 0);
});
