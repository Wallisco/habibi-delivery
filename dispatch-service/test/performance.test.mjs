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
  assert.ok(p.waiting.some((w) => /query log/.test(w.why)));
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

/* ------------------------------------------- step 2: online time and CM2 */

import { DatabaseSync } from 'node:sqlite';
import { OnlineTime, MAX_GAP_MS } from '../src/onlineTime.js';
import { PerfSettings } from '../src/perfSettings.js';

test('online time counts the gaps between app signals, but not a gap over 2 minutes or time offline', () => {
  const t0 = Date.UTC(2026, 9, 8, 8);
  const ot = new OnlineTime({ sql: new DatabaseSync(':memory:') });
  for (let i = 0; i <= 60; i++) ot.beat('D1', { online: true, zone: 'A', at: t0 + i * 60000 });   // an hour, a signal a minute
  ot.beat('D1', { online: true, zone: 'A', at: t0 + 60 * 60000 + MAX_GAP_MS + 1000 });            // app closed: not counted
  ot.beat('D1', { online: false, zone: 'A', at: t0 + 70 * 60000 });                              // went offline
  ot.beat('D1', { online: false, zone: 'A', at: t0 + 71 * 60000 });
  for (let i = 0; i <= 30; i++) ot.beat('D2', { online: true, zone: 'B', at: t0 + i * 60000 });
  assert.equal(ot.hours(t0), 1.5);
  assert.equal(ot.hours(t0, 'A'), 1);
  assert.equal(ot.hours(t0, 'B'), 0.5);
});

test('drops per hour: deliveries over driver hours online', () => {
  const p = performance([order(), order(), order()], { sinceMs: since, now: NOW, onlineHours: 2 });
  assert.equal(p.metrics.dropsPerHour.value, 1.5);
  assert.equal(performance([order()], { sinceMs: since, now: NOW, onlineHours: 0 }).metrics.dropsPerHour.value, null);
  assert.equal(performance([order()], { sinceMs: since, now: NOW, onlineHours: 2, storeId: 'KFC-MIL' }).metrics.dropsPerHour.value,
    null, 'hours are not split by store');
});

test('CM2: CM1 minus payment fees, refunds, support time and the AI photo check', () => {
  // Revenue R6 + R30 = R36, driver pay R25: CM1 R11.
  const checked = order({ charge: 30, pay: 25 });
  checked.photoCheck = { model: 'claude-opus-5-5', usage: { input: 1800, output: 120 } };   // US$0.0096
  const refunded = order({ charge: 30, pay: 25 });
  const costs = { values: { paymentFeePct: 2.5, paymentFeeFixed: 1, supportCostPerQuery: 8, usdZar: 20 },
    set: { paymentFeePct: true, paymentFeeFixed: true, supportCostPerQuery: true, usdZar: true } };
  const p = performance([checked, refunded], { sinceMs: since, now: NOW, costs,
    queries: [{ jobId: refunded.id, refund: 15 }] });
  // Fees 0.9 + 1 each; photo 0.192 on one; refund 15 and support 8 on the other.
  const cm2 = (11 - 1.9 - 0.192 + 11 - 1.9 - 15 - 8) / 2;
  assert.equal(p.metrics.cm2PerOrder.value, Number(cm2.toFixed(2)));
  assert.deepEqual(p.metrics.cm2PerOrder.parts, { paymentFees: 1.9, refunds: 7.5, support: 4, photoCheck: 0.1 });
  assert.deepEqual(p.metrics.cm2PerOrder.unset, []);
  assert.equal(p.metrics.profitableOrders.share, 0.5, 'the refunded order lost money');
  assert.equal(p.metrics.profitableOrders.value, Math.round((1 / 7) * 30), 'a month at this rate');
});

test('cost settings: unset ones are flagged; bad values refused; ops can change them', async (t) => {
  const ps = new PerfSettings({ sql: new DatabaseSync(':memory:') });
  assert.equal(ps.get().set.paymentFeePct, false);
  assert.match(ps.update({ paymentFeePct: 90 }), /from 0 to 20/);
  assert.match(ps.update({ nonsense: 1 }), /Unknown/);
  assert.equal(ps.update({ paymentFeePct: 2.9 }), null);
  assert.deepEqual([ps.get().values.paymentFeePct, ps.get().set.paymentFeePct], [2.9, true]);
  const p = performance([order()], { sinceMs: since, now: NOW, costs: ps.get() });
  assert.ok(p.metrics.cm2PerOrder.unset.includes('supportCostPerQuery'));

  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/ops/performance/settings', payload: { paymentFeePct: 'x' } })).statusCode, 400);
  const ok = await app.inject({ method: 'PUT', url: '/v1/ops/performance/settings', payload: { supportCostPerQuery: 12 } });
  assert.equal(ok.json().values.supportCostPerQuery, 12);
  const got = (await app.inject({ url: '/v1/ops/performance/settings' })).json();
  assert.ok(got.fields.usdZar.label);
});

test('a driver going online and sending positions is counted on the dashboard', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false, driverAuth: false });
  t.after(() => app.close());
  const { online, supply } = app.engine;
  supply.upsert('D9', { state: 'ZONE_COMMITTED', zone: 'Milnerton' });
  // Signals a minute apart, as if the app had sent them.
  const t0 = Date.now() - 30 * 60000;
  for (let i = 0; i <= 30; i++) online.beat('D9', { online: true, zone: 'Milnerton', at: t0 + i * 60000 });
  online.flush();
  const p = (await app.inject({ url: '/v1/ops/performance?days=1' })).json();
  assert.equal(p.metrics.dropsPerHour.hours, 0.5);
});
