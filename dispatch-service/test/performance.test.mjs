// The performance dashboard, worked out from hand-made orders whose answers are known.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance, rate, TARGETS, PLATFORM_FEE } from '../src/performance.js';
import { build } from '../src/server.js';

const NOW = Date.UTC(2026, 9, 8, 12);
const MIN = 60000;
let n = 0;
/** A delivered order: `mins` from order to door, `wait` at the store, `km` to the customer. */
const order = ({ mins = 25, wait = 3, km = 4, zone = 'Milnerton', storeId = 'KFC-MIL', batchId = null,
  status = 'DELIVERED', charge = 30, pay = 25, history = [], promiseMins = 45, ageMin = 120 } = {}) => {
  const createdAt = NOW - ageMin * MIN;
  return {
    id: `J${++n}`, status, zone, storeId, batchId, distanceKm: km, createdAt,
    promiseAt: createdAt + promiseMins * MIN,
    readyAt: createdAt + 10 * MIN, collectedAt: createdAt + (10 + wait) * MIN,
    completedAt: status === 'DELIVERED' ? createdAt + mins * MIN : null,
    customerCharge: charge, earnings: { platformFunded: pay }, history,
  };
};
const since = NOW - 7 * 86400000;

test('speed, SLA and breaches: within 30 minutes of the order, and by the promised time', () => {
  const p = performance([order({ mins: 20 }), order({ mins: 30 }), order({ mins: 35 }), order({ mins: 50 })],
    { sinceMs: since, now: NOW });
  assert.equal(p.metrics.within30.value, 0.5);
  assert.equal(p.metrics.zoneBreaches.value, 0.5);
  assert.equal(p.metrics.withinSla.value, 0.75, '50 minutes misses the 45-minute promise');
  assert.equal(p.core.speed.value, 0.5);
  assert.equal(p.core.speed.status, 'bad');
});

test('driver wait, batching, first-attempt delivery and distance against their targets', () => {
  const p = performance([
    order({ wait: 2, batchId: 'RUN-1', km: 3 }), order({ wait: 4, batchId: 'RUN-1', km: 6 }),
    order({ wait: 12, batchId: 'RUN-2', km: 8 }),                         // alone in its run: not batched
    order({ wait: 2, history: [{ kind: 'REASSIGNED' }] }),               // delivered, but not first try
    order({ status: 'FAILED' }),
  ], { sinceMs: since, now: NOW });
  assert.equal(p.metrics.driverWait.value, 5, 'average of 2, 4, 12, 2');
  assert.equal(p.metrics.driverWait.over5, 0.25);
  assert.equal(p.metrics.batching.value, 0.5, '2 of 4 delivered orders went out together');
  assert.equal(p.metrics.batching.status, 'good');
  assert.equal(p.metrics.fad.value, 0.6, '3 of 5 finished orders at the first try');
  assert.equal(p.metrics.fad.status, 'bad');
  assert.equal(p.metrics.distance.value, 8);
  assert.equal(p.metrics.over7km.value, 0.25);
});

test(`contribution margin: R${PLATFORM_FEE} plus the delivery fee, minus driver pay`, () => {
  const p = performance([order({ charge: 30, pay: 25 }), order({ charge: 20, pay: 30 }), order({ charge: null })],
    { sinceMs: since, now: NOW });
  assert.equal(p.metrics.revenuePerOrder.value, PLATFORM_FEE + 25);
  assert.equal(p.metrics.cm1PerOrder.value, PLATFORM_FEE + 25 - 27.5);
  assert.equal(p.metrics.cm1PerOrder.priced, 2, 'an order without a charge is left out, not counted as zero');
  assert.equal(p.core.margin.value, p.metrics.cm1PerOrder.value);
});

test('zones and distance bands show where the 30-minute promise breaks', () => {
  const p = performance([
    order({ zone: 'A', mins: 20, km: 2 }), order({ zone: 'A', mins: 25, km: 4 }),
    order({ zone: 'B', mins: 40, km: 8 }), order({ zone: 'B', mins: 20, km: 6 }),
  ], { sinceMs: since, now: NOW });
  const z = Object.fromEntries(p.byZone.map((x) => [x.zone, x]));
  assert.deepEqual([z.A.breaches, z.A.breachStatus], [0, 'good']);
  assert.deepEqual([z.B.breaches, z.B.breachStatus], [0.5, 'bad']);
  const b = Object.fromEntries(p.byDistance.map((x) => [x.band, x]));
  assert.equal(b['7+ km'].breaches, 1);
  assert.equal(b['0–3 km'].orders, 1);
  // Filtered to one zone.
  assert.equal(performance(p.byZone.length ? [order({ zone: 'A' }), order({ zone: 'B' })] : [],
    { sinceMs: since, now: NOW, zone: 'A' }).volume.delivered, 1);
});

test('weeks, newest last; metrics without data say what they wait for', () => {
  const p = performance([order({ ageMin: 60 }), order({ ageMin: 60 * 24 * 9 })],
    { sinceMs: NOW - 14 * 86400000, now: NOW });
  assert.equal(p.weeks.length, 2);
  assert.deepEqual(p.weeks.map((w) => w.delivered), [1, 1]);
  assert.equal(p.core.gmv.value, null);
  assert.match(p.core.gmv.waiting, /Keychat/);
  assert.match(p.core.matu.waiting, /customer id/);
  assert.ok(p.waiting.length >= 4);
});

test('good / warn / bad: shares within 3 points are nearly there, minutes within 20%', () => {
  assert.equal(rate(0.99, TARGETS.fad), 'good');
  assert.equal(rate(0.96, TARGETS.fad), 'warn');
  assert.equal(rate(0.9, TARGETS.fad), 'bad');
  assert.equal(rate(5.8, TARGETS.driverWait), 'warn');
  assert.equal(rate(8, TARGETS.driverWait), 'bad');
  assert.equal(rate(null, TARGETS.fad), null);
});

test('the back office route answers from the live orders', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  const res = await app.inject({ url: '/v1/ops/performance?days=7' });
  assert.equal(res.statusCode, 200);
  const p = res.json();
  assert.ok(p.core && p.metrics && Array.isArray(p.byZone) && Array.isArray(p.weeks));
});
