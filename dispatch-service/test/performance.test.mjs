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
  assert.match(p.core.gmv.waiting, /orderValue/);
  assert.match(p.core.matu.waiting, /customerId/);
  assert.ok(p.core.gmv.waiting && p.core.matu.waiting, 'no basket totals or customer ids in these orders');
  assert.equal(p.core.quality.value, 1, 'on time, nothing reported: perfect');
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

/* ------------------------------------- step 3: query log, QA and payoff */

import { SupportQueries } from '../src/queries.js';
import { allowed } from '../src/opsAuth.js';

test('the query log: types and channels checked, refunds kept, a mistake can be removed', () => {
  const sq = new SupportQueries({ sql: new DatabaseSync(':memory:') });
  assert.match(sq.add({ type: 'cold food', channel: 'call' }).error, /type must be/);
  assert.match(sq.add({ type: 'late', channel: 'pigeon' }).error, /channel must be/);
  assert.match(sq.add({ type: 'late', channel: 'call', refund: -5 }).error, /refund/);
  const { query } = sq.add({ jobId: 'J1', type: 'missing_item', channel: 'call', refund: 25, note: 'No Sprite' }, 'Ayesha');
  assert.deepEqual([query.type, query.refund, query.by], ['missing_item', 25, 'Ayesha']);
  assert.equal(sq.forJob('J1').length, 1);
  assert.equal(sq.since(0).length, 1);
  assert.equal(sq.remove(query.id), true);
  assert.equal(sq.forJob('J1').length, 0);
});

test('QA error rate, queries per 100 and the perfect order rate', () => {
  const a = order({ mins: 20 }), b = order({ mins: 20 }), late = order({ mins: 50 }), d = order({ mins: 20 });
  const queries = [
    { jobId: a.id, type: 'missing_item', channel: 'call', refund: 30 },
    { jobId: b.id, type: 'driver_conduct', channel: 'message', refund: 0 },   // not a quality problem
    { jobId: null, type: 'other', channel: 'call', refund: 0 },              // about no order
  ];
  const p = performance([a, b, late, d], { sinceMs: since, now: NOW, queries });
  assert.equal(p.qa.qaErrorRate.value, 0.25, '1 of 4 delivered orders had a quality problem');
  assert.equal(p.qa.queriesPer100.value, 50, '2 queries on orders, per 100 delivered');
  assert.equal(p.qa.por.value, 0.5, 'not the one with a missing item, not the late one');
  assert.equal(p.core.quality.value, 0.5);
  assert.deepEqual([p.qa.queries, p.qa.qualityQueries, p.qa.calls, p.qa.refunds], [3, 1, 2, 30]);
  assert.equal(p.qa.byType.find((t) => t.type === 'missing_item').per100, 25);
  // A store filter leaves out the query that isn't about an order.
  assert.equal(performance([a, b, late, d], { sinceMs: since, now: NOW, queries, storeId: 'KFC-MIL' }).qa.queries, 2);
});

test('does the photo check pay off: quality cost of checked against unchecked orders, minus what the check costs', () => {
  const costs = { values: { supportCostPerQuery: 10, usdZar: 20 }, set: {} };
  const usage = { input: 1800, output: 120 };                  // US$0.0096 = R0.192 at R20
  const checked = Array.from({ length: 20 }, () => Object.assign(order(), { photoCheck: { model: 'claude-opus-5-5', usage, status: 'complete' } }));
  checked[0].photoCheck.status = 'missing';                    // caught at the store
  const unchecked = Array.from({ length: 20 }, () => order());
  const queries = [
    { jobId: checked[1].id, type: 'damaged', channel: 'call', refund: 20 },                  // R30 with support
    ...unchecked.slice(0, 4).map((j) => ({ jobId: j.id, type: 'missing_item', channel: 'call', refund: 20 })),  // 4 × R30
  ];
  const pc = performance([...checked, ...unchecked], { sinceMs: since, now: NOW, costs, queries }).qa.photoCheck;
  assert.deepEqual([pc.checked.qualityPer100, pc.unchecked.qualityPer100], [5, 20]);
  assert.deepEqual([pc.checked.qualityCostPerOrder, pc.unchecked.qualityCostPerOrder], [1.5, 6]);
  assert.equal(pc.checked.checkCostPerOrder, 0.19);
  assert.equal(pc.checked.caughtAtStore, 1);
  assert.equal(pc.savingPerCheckedOrder, 4.31, 'R6 - R1.50 - R0.19');
  assert.equal(pc.paysOff, true);
  assert.equal(pc.costPerQualityQuery, 30);
  assert.equal(pc.breakEvenPer100, 0.63, 'R0.19 / R30, per 100 orders');
  assert.equal(pc.enough, true);
});

test('the office logs a query on an order; it shows on the order and on the dashboard', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  const jobId = (await app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: { storeId: 'KFC-MIL', zone: 'Milnerton',
    pickup: { lat: -33.83, lng: 18.65 }, dropoff: { lat: -33.82, lng: 18.65 }, dispatchNow: true } })).json().jobId;
  assert.equal((await app.inject({ method: 'POST', url: '/v1/ops/queries', payload: { jobId: 'NOPE', type: 'late', channel: 'call' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/ops/queries', payload: { jobId, type: 'x', channel: 'call' } })).statusCode, 400);
  const res = await app.inject({ method: 'POST', url: '/v1/ops/queries', payload: { jobId, type: 'missing_item', channel: 'call', refund: 15 } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().query.storeId, 'KFC-MIL', 'the store and zone come from the order');
  const detail = (await app.inject({ url: `/v1/ops/orders/${jobId}` })).json();
  assert.equal(detail.queries.length, 1);
  assert.ok(detail.queryTypes.missing_item);
  const p = (await app.inject({ url: '/v1/ops/performance?days=1' })).json();
  assert.equal(p.qa.qualityQueries, 1);
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/ops/queries/${res.json().query.id}` })).statusCode, 200);
  assert.equal((await app.inject({ url: `/v1/ops/orders/${jobId}` })).json().queries.length, 0);
});

test('who may do what: ops log queries; viewers only look; finance may set the CM2 costs', () => {
  assert.equal(allowed('ops', 'POST', '/v1/ops/queries'), true);
  assert.equal(allowed('viewer', 'POST', '/v1/ops/queries'), false);
  assert.equal(allowed('viewer', 'GET', '/v1/ops/performance'), true);
  assert.equal(allowed('finance', 'PUT', '/v1/ops/performance/settings'), true);
  assert.equal(allowed('ops', 'PUT', '/v1/ops/performance/settings'), true);
  assert.equal(allowed('viewer', 'PUT', '/v1/ops/performance/settings'), false);
});

/* --------------------------------------------- step 4: GMV and MATU */

import { CustomerRefs } from '../src/customerRef.js';

test('GMV run rate: delivered basket totals, a month and a year at this rate', () => {
  const p = performance([Object.assign(order(), { orderValue: 200 }), Object.assign(order(), { orderValue: 300 }), order()],
    { sinceMs: since, now: NOW });
  assert.equal(p.core.gmv.value, Math.round((500 / 7) * 30));
  assert.equal(p.core.gmv.annual, Math.round((500 / 7) * 30 * 12));
  assert.equal(p.core.gmv.avgBasket, 250);
  assert.equal(p.core.gmv.coverage, 0.667, 'one order came without a basket total');
  assert.match(performance([order()], { sinceMs: since, now: NOW }).core.gmv.waiting, /orderValue/);
});

test('MATU: distinct customers with a delivered order in the last 30 days, whatever the period shown', () => {
  const o = (ref, ageDays) => Object.assign(order({ ageMin: ageDays * 1440 }), { customerRef: ref });
  const jobs = [o('c_a', 1), o('c_a', 2), o('c_b', 20), o('c_c', 40), order()];
  const p = performance(jobs, { sinceMs: since, now: NOW });     // a 7-day view
  assert.equal(p.core.matu.value, 2, 'a and b; c ordered 40 days ago');
  assert.equal(p.core.matu.coverage, 0.75);
  assert.match(performance([order()], { sinceMs: since, now: NOW }).core.matu.waiting, /customerId/);
});

test('customer ids are kept only as a keyed fingerprint, stable per server', () => {
  const sql = new DatabaseSync(':memory:');
  const a = new CustomerRefs({ sql });
  assert.equal(a.ref('KC-CUST-1'), a.ref('KC-CUST-1'));
  assert.notEqual(a.ref('KC-CUST-1'), a.ref('KC-CUST-2'));
  assert.equal(new CustomerRefs({ sql }).ref('KC-CUST-1'), a.ref('KC-CUST-1'), 'same key after a restart');
  assert.notEqual(new CustomerRefs({ sql: new DatabaseSync(':memory:') }).ref('KC-CUST-1'), a.ref('KC-CUST-1'), 'another server, another key');
  assert.ok(!a.ref('0821234567').includes('0821234567'));
  assert.equal(a.ref(null), null);
});

test('Keychat sends orderValue and customerId; the raw id is never stored', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  const base = { storeId: 'KFC-MIL', zone: 'Milnerton', pickup: { lat: -33.83, lng: 18.65 }, dropoff: { lat: -33.82, lng: 18.65 } };
  const post = (extra) => app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: { ...base, ...extra } });
  assert.equal((await post({ orderValue: -1 })).statusCode, 400);
  assert.equal((await post({ orderValue: '245' })).statusCode, 400);
  assert.equal((await post({ customerId: '' })).statusCode, 400);
  const res = await post({ orderValue: 245.5, customerId: 'KC-CUST-88213' });
  assert.equal(res.statusCode, 201);
  const job = app.engine.jobs.get(res.json().jobId);
  assert.equal(job.orderValue, 245.5);
  assert.match(job.customerRef, /^c_[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(job).includes('KC-CUST-88213'), 'the raw id is not kept');
  const stored = app.engine.db.loadJob(job.id);
  assert.ok(!JSON.stringify(stored).includes('KC-CUST-88213'));
});
