import test from 'node:test';
import assert from 'node:assert/strict';
import { canJoin, routeStops, routeMinutes, marginalDistances, storeCount,
  isSameCustomer, MAX_BATCH, PICKUP_CLUSTER_M } from '../src/batching.js';
import { computeEarnings } from '../src/fees.js';
import { RateBook } from '../src/rates.js';
import { ReadyGate } from '../src/readyGate.js';

const card = new RateBook().forZone('Milnerton');
const BASE = { lat: -33.8329992, lng: 18.5309754 };

/** Metres offset on a bearing, for building realistic test geometry. */
function at(m, bearingDeg, from = BASE) {
  const b = (bearingDeg * Math.PI) / 180;
  return {
    lat: from.lat + (m * Math.cos(b)) / 111320,
    lng: from.lng + (m * Math.sin(b)) / (111320 * Math.cos((from.lat * Math.PI) / 180)),
  };
}

function job(id, storeId, pickup, dropoff, prep = 12, createdAt = Date.now()) {
  return { id, storeId, pickup, dropoff, createdAt, merchantPrepMinutes: prep,
    zone: 'Milnerton', bagCount: 1 };
}

function warmGate(stores, minutes = 12) {
  const g = new ReadyGate();
  for (const s of stores) {
    for (let i = 0; i < 12; i++) g.observe(s, minutes, { source: 'print', persist: false });
  }
  return g;
}

/* ------------------------------------------------------------- eligibility */

test('two orders from one store dropping nearby can stack', () => {
  const g = warmGate(['ROCO']);
  const a = job('A', 'ROCO', BASE, at(300, 0));
  const b = job('B', 'ROCO', BASE, at(380, 30));
  const res = canJoin([a], b, g);
  assert.equal(res.ok, true, res.reason);
});

test('drop-offs further apart than 500 m are refused', () => {
  const g = warmGate(['ROCO']);
  const a = job('A', 'ROCO', BASE, at(200, 0));
  const b = job('B', 'ROCO', BASE, at(900, 180));
  const res = canJoin([a], b, g);
  assert.equal(res.ok, false);
  assert.match(res.reason, /drop-offs/);
});

test('pickups further apart than 500 m are refused', () => {
  const g = warmGate(['ROCO', 'FAR']);
  const a = job('A', 'ROCO', BASE, at(200, 0));
  const b = job('B', 'FAR', at(1200, 90), at(250, 10));
  const res = canJoin([a], b, g);
  assert.equal(res.ok, false);
  assert.match(res.reason, /pickups/);
});

test('two nearby stores for the same customer stack', () => {
  const g = warmGate(['ROCO', 'PIZZA']);
  const home = at(300, 45);
  const a = job('A', 'ROCO', BASE, home);
  const b = job('B', 'PIZZA', at(400, 90), home);
  const res = canJoin([a], b, g);
  assert.equal(res.ok, true, res.reason);
  assert.equal(isSameCustomer([a, b]), true);
  assert.equal(storeCount([a, b]), 2, 'two kitchens means two pickup stops');
});

test('a slow kitchen is not stacked onto a fast one', () => {
  // 8 minute prep against 40 minute prep: the first order would sit under a
  // heat lamp while the driver waits for the second.
  const g = new ReadyGate();
  for (let i = 0; i < 12; i++) {
    g.observe('FAST', 8, { source: 'print', persist: false });
    g.observe('SLOW', 40, { source: 'print', persist: false });
  }
  const a = job('A', 'FAST', BASE, at(200, 0), 8);
  const b = job('B', 'SLOW', at(200, 90), at(260, 20), 40);
  const res = canJoin([a], b, g);
  assert.equal(res.ok, false);
  assert.match(res.reason, /ready times/);
});

test('the batch is capped at three', () => {
  const g = warmGate(['ROCO']);
  const batch = [
    job('A', 'ROCO', BASE, at(200, 0)),
    job('B', 'ROCO', BASE, at(240, 40)),
    job('C', 'ROCO', BASE, at(280, 80)),
  ];
  const res = canJoin(batch, job('D', 'ROCO', BASE, at(300, 120)), g);
  assert.equal(res.ok, false);
  assert.match(res.reason, new RegExp(String(MAX_BATCH)));
});

/* ----------------------------------------------------------------- routing */

test('every pickup is visited before any drop-off', () => {
  const jobs = [
    job('A', 'ROCO', BASE, at(300, 0)),
    job('B', 'PIZZA', at(300, 90), at(350, 30)),
  ];
  const kinds = routeStops(jobs).map((s) => s.kind);
  assert.deepEqual(kinds, ['PICKUP', 'PICKUP', 'DROPOFF', 'DROPOFF'],
    'collect everything, then deliver -- what a driver would do unprompted');
});

test('two orders from one store are a single pickup stop', () => {
  const jobs = [
    job('A', 'ROCO', BASE, at(300, 0)),
    job('B', 'ROCO', BASE, at(340, 40)),
  ];
  const stops = routeStops(jobs);
  const pickups = stops.filter((s) => s.kind === 'PICKUP');
  assert.equal(pickups.length, 1);
  assert.deepEqual(pickups[0].jobIds, ['A', 'B']);
});

test('marginal distance is far less than the standalone trip', () => {
  const jobs = [
    job('A', 'ROCO', BASE, at(400, 0)),
    job('B', 'ROCO', BASE, at(430, 20)),
  ];
  const marg = marginalDistances(jobs);
  const solo = routeMinutes([jobs[0]]).km;
  assert.ok(marg[1].marginalKm < solo,
    'the second order adds a fraction of a full trip, which is why it is paid less');
});

/* ----------------------------------------------------------------- pricing */

test('a stacked order pays for marginal work, not repeated fixed costs', () => {
  const j = { id: 'B', zone: 'Milnerton', bagCount: 1, distanceKm: 3.2 };
  const solo = computeEarnings(j, card, { collectKm: 0.9, deliverKm: 3.2, tip: 0 });
  const stacked = computeEarnings(j, card,
    { stacked: true, newStore: false, batchSize: 2, marginalKm: 0.8, tip: 0 });

  const codes = stacked.lines.map((l) => l.code);
  assert.ok(!codes.includes('COLLECTION_BASE'), 'already at the store');
  assert.ok(codes.includes('STACKED_DELIVERY'), 'still an extra drop');
  assert.ok(stacked.platformFunded < solo.platformFunded);
  assert.ok(stacked.platformFunded > 10, 'but not so little that a driver declines batches');
});

test('a second store on the run is paid for, a second order from one store is not', () => {
  const j = { id: 'B', zone: 'Milnerton', bagCount: 1, distanceKm: 3.2 };
  const sameStore = computeEarnings(j, card,
    { stacked: true, newStore: false, batchSize: 2, marginalKm: 0.8 });
  const newStore = computeEarnings(j, card,
    { stacked: true, newStore: true, batchSize: 2, marginalKm: 0.8, collectKm: 0.4 });

  assert.ok(!sameStore.lines.some((l) => l.code === 'STACKED_COLLECTION'));
  assert.ok(newStore.lines.some((l) => l.code === 'STACKED_COLLECTION'));
  assert.ok(newStore.platformFunded > sameStore.platformFunded,
    'an extra stop is extra work and must be paid');
});

test('waiting is paid in full on every order in the batch', () => {
  const j = { id: 'B', zone: 'Milnerton', bagCount: 1, distanceKm: 3.2 };
  const solo = computeEarnings(j, card, { collectKm: 0.9, deliverKm: 3.2, waitMinutes: 20 });
  const stacked = computeEarnings(j, card,
    { stacked: true, newStore: true, batchSize: 2, marginalKm: 0.8, waitMinutes: 20 });

  const a = solo.lines.find((l) => l.code === 'DELAY').amount;
  const b = stacked.lines.find((l) => l.code === 'DELAY').amount;
  assert.equal(a, b, 'time standing still is time standing still');
});

test('stacking raises the driver\u2019s hourly rate while lowering cost per order', () => {
  const j = { id: 'X', zone: 'Milnerton', bagCount: 1, distanceKm: 3.2 };
  const solo = computeEarnings(j, card, { collectKm: 0.9, deliverKm: 3.2, tip: 15 });
  const stacked = computeEarnings(j, card,
    { stacked: true, newStore: false, batchSize: 3, marginalKm: 0.8, tip: 15 });

  // Three separate runs: about 25 engaged minutes each.
  const separateEarn = 3 * solo.total;
  const separateMin = 3 * 25;

  // One batched run: the first order's full trip plus two short detours.
  const batchEarn = solo.total + 2 * stacked.total;
  const batchMin = 25 + 2 * 7;

  const perHourSeparate = (separateEarn / separateMin) * 60;
  const perHourBatched = (batchEarn / batchMin) * 60;

  assert.ok(perHourBatched > perHourSeparate,
    `batching must pay better per hour or drivers will decline it ` +
    `(R${perHourBatched.toFixed(0)}/h vs R${perHourSeparate.toFixed(0)}/h)`);

  const costPerOrderSeparate = solo.platformFunded;
  const costPerOrderBatched = (solo.platformFunded + 2 * stacked.platformFunded) / 3;
  assert.ok(costPerOrderBatched < costPerOrderSeparate,
    'and it must cost us less per order, or there is no reason to do it');
});

test('tips are never reduced by stacking', () => {
  const j = { id: 'B', zone: 'Milnerton', bagCount: 1, distanceKm: 3.2 };
  const e = computeEarnings(j, card,
    { stacked: true, newStore: false, batchSize: 3, marginalKm: 0.8, tip: 25 });
  assert.equal(e.tip, 25);
  assert.equal(e.lines.find((l) => l.code === 'TIP').fundedBy, 'customer');
});

/* ----------------------------------------------------- dispatch integration */

test('a declined offer becomes available again after the cooldown', async (t) => {
  const { build } = await import('../src/server.js');
  const { TIMEOUT_COOLDOWN_MS } = await import('../src/dispatch.js');
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());

  const res = await app.inject({ method: 'POST', url: '/v1/driver/signin',
    payload: { phone: '0821234567', firstName: 'Solo' } });
  const id = res.json().driver.id;
  for (const d of (await app.inject({ url: `/v1/driver/${id}/account` })).json().requiredDocs) {
    await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/document`,
      payload: { docKey: d.key, status: 'VERIFIED' } });
  }
  await app.inject({ method: 'PATCH', url: `/v1/ops/accounts/${id}`,
    payload: { vehicleReg: 'CA 1' } });
  await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/onboarding`,
    payload: { state: 'ACTIVE' } });
  await app.inject({ method: 'POST', url: `/v1/driver/${id}/state`,
    payload: { state: 'ZONE_COMMITTED', zone: 'Z' } });
  await app.inject({ method: 'POST', url: `/v1/driver/${id}/position`,
    payload: { lat: BASE.lat, lng: BASE.lng } });

  const created = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'S', zone: 'Z', pickup: BASE, dropoff: at(300, 0),
      dispatchNow: true } });
  const jobId = created.json().jobId;

  const dispatcher = app.engine.dispatcher;
  assert.equal(dispatcher.tick(), 1, 'offered once');
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/decline`,
    payload: { driverId: id } });

  // Immediately after, the same driver must not be pestered.
  assert.equal(dispatcher.tick(), 0, 'still cooling down');

  // But with only one driver on the zone, a permanent block would strand the
  // job forever. This is the bug that left eight of ten test orders unoffered.
  const later = Date.now() + TIMEOUT_COOLDOWN_MS + 11 * 60_000;
  assert.equal(dispatcher.tick(later), 1, 'offered again once the cooldown passes');
});

test('a second order from the same kitchen prefers the driver already there', async (t) => {
  const { build } = await import('../src/server.js');
  const app = build({ dbPath: ':memory:' });
  t.after(() => app.close());

  const ids = [];
  for (const phone of ['0821111111', '0822222222']) {
    const r = await app.inject({ method: 'POST', url: '/v1/driver/signin', payload: { phone } });
    const id = r.json().driver.id;
    for (const d of (await app.inject({ url: `/v1/driver/${id}/account` })).json().requiredDocs) {
      await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/document`,
        payload: { docKey: d.key, status: 'VERIFIED' } });
    }
    await app.inject({ method: 'PATCH', url: `/v1/ops/accounts/${id}`,
      payload: { vehicleReg: 'CA 1' } });
    await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/onboarding`,
      payload: { state: 'ACTIVE' } });
    await app.inject({ method: 'POST', url: `/v1/driver/${id}/state`,
      payload: { state: 'ZONE_COMMITTED', zone: 'Z' } });
    ids.push(id);
  }

  // Driver A is at the kitchen holding an uncollected order.
  // Driver B is idle and slightly closer to nothing in particular.
  await app.inject({ method: 'POST', url: `/v1/driver/${ids[0]}/position`,
    payload: { lat: BASE.lat, lng: BASE.lng } });
  await app.inject({ method: 'POST', url: `/v1/driver/${ids[1]}/position`,
    payload: { lat: BASE.lat, lng: BASE.lng } });

  const first = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'ROCO', zone: 'Z', pickup: BASE, dropoff: at(300, 0),
      dispatchNow: true } });
  app.engine.dispatcher.tick();
  await app.inject({ method: 'POST', url: `/v1/jobs/${first.json().jobId}/accept`,
    payload: { driverId: ids[0] } });

  // A second order from the same kitchen, dropping nearby.
  const second = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'ROCO', zone: 'Z', pickup: BASE, dropoff: at(340, 25),
      dispatchNow: true } });
  app.engine.dispatcher.tick();

  const offer = app.engine.dispatcher.offers.get(second.json().jobId);
  assert.ok(offer, 'the second order must be offered');
  assert.equal(offer.driverId, ids[0],
    'the driver already standing in that kitchen should get it, not a second driver');
});
