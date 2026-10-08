/**
 * The performance dashboard: the five core service metrics and the
 * operational ones under them, each against its target.
 *
 *   SPEED        % of orders delivered within 30 minutes of the order
 *   QUALITY      perfect order rate: on time, nothing missing, nothing damaged
 *   GMV          run rate of what customers spend (needs the basket from Keychat)
 *   MARGIN       revenue per order minus driver pay (contribution margin)
 *   MATU         monthly transacting users (needs a customer id from Keychat)
 *
 * Everything here is worked out from the orders themselves. Metrics that need
 * data we do not have yet say so, and why, rather than showing a number.
 */

import { checkCost } from './photoCheck.js';
import { COST_SETTINGS } from './perfSettings.js';
import { QUERY_TYPES, isQuality } from './queries.js';

const MIN = 60000;
const round = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const share = (n, of) => (of ? round(n / of, 3) : null);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function pct(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

/** Targets. `atLeast` / `atMost` say which side is good. */
export const TARGETS = {
  within30: { target: 0.97, dir: 'atLeast', unit: 'share' },       // the flip side of < 3% breaches
  zoneBreaches: { target: 0.03, dir: 'atMost', unit: 'share' },     // orders over 30 minutes
  driverWait: { target: 5, dir: 'atMost', unit: 'min' },
  batching: { target: 0.30, dir: 'atLeast', unit: 'share' },
  fad: { target: 0.985, dir: 'atLeast', unit: 'share' },
  maxDistance: { target: 7, dir: 'atMost', unit: 'km' },
  over7km: { target: 0, dir: 'atMost', unit: 'share' },
};

/** Revenue on every order on top of the delivery fee (R6 an order). */
export const PLATFORM_FEE = Number(process.env.PLATFORM_FEE_PER_ORDER ?? 6);

/**
 * good / warn / bad against a target. Shares are "nearly there" within 3
 * points; minutes and km within 20%.
 */
export function rate(value, { target, dir, unit }) {
  if (value == null) return null;
  const slack = unit === 'share' ? 0.03 : Math.max(target * 0.2, 0.5);
  const good = dir === 'atLeast' ? value >= target : value <= target;
  if (good) return 'good';
  const near = dir === 'atLeast' ? value >= target - slack : value <= target + slack;
  return near ? 'warn' : 'bad';
}
const metric = (value, key, extra = {}) => ({ value, target: TARGETS[key].target, unit: TARGETS[key].unit,
  dir: TARGETS[key].dir, status: rate(value, TARGETS[key]), ...extra });

const minutes = (j) => (j.completedAt && j.createdAt ? (j.completedAt - j.createdAt) / MIN : null);
const waitMin = (j) => (j.readyAt && j.collectedAt ? (j.collectedAt - j.readyAt) / MIN : null);
/** Delivered at the first try: not failed, not reassigned or cleared by the office. */
const firstTry = (j) => j.status === 'DELIVERED'
  && !(j.history ?? []).some((h) => h.kind === 'REASSIGNED' || h.kind === 'CLEARED');
const revenue = (j) => (j.customerCharge != null ? PLATFORM_FEE + j.customerCharge : null);
const driverPay = (j) => j.earnings?.platformFunded ?? null;

const DEFAULT_COSTS = Object.fromEntries(Object.entries(COST_SETTINGS).map(([k, d]) => [k, d.default]));
/**
 * What an order costs beyond driver pay, in Rand: payment fees, refunds and
 * support time (from the query log), and the AI photo check. Only the model
 * the driver sees is counted; the trial's comparison models are not a cost
 * the business would carry.
 */
function extraCosts(j, costs, queries) {
  const rev = revenue(j) ?? 0;
  const q = queries.get(j.id) ?? [];
  const photo = j.photoCheck?.usage ? checkCost(j.photoCheck.usage, j.photoCheck.model) * costs.usdZar : 0;
  return {
    paymentFees: (rev * costs.paymentFeePct) / 100 + costs.paymentFeeFixed,
    refunds: q.reduce((a, x) => a + (x.refund ?? 0), 0),
    support: q.length * costs.supportCostPerQuery,
    photoCheck: photo,
  };
}

export const DISTANCE_BANDS = [[0, 3], [3, 5], [5, 7], [7, Infinity]];
const bandLabel = ([a, b]) => (b === Infinity ? `${a}+ km` : `${a}–${b} km`);

/** The core numbers for a set of orders (used for the period, each zone, each week). */
function core(list, costs = DEFAULT_COSTS, queries = new Map()) {
  const done = list.filter((j) => j.status === 'DELIVERED' && j.completedAt);
  const finished = list.filter((j) => ['DELIVERED', 'FAILED'].includes(j.status));
  const mins = done.map(minutes).filter((v) => v != null);
  const within30 = mins.filter((m) => m <= 30).length;
  const onSla = done.filter((j) => j.promiseAt && j.completedAt <= j.promiseAt).length;
  const waits = done.map(waitMin).filter((v) => v != null);
  const kms = done.map((j) => j.distanceKm).filter((v) => v != null);

  // A run is batched when two or more delivered orders share it.
  const runSize = new Map();
  for (const j of done) if (j.batchId) runSize.set(j.batchId, (runSize.get(j.batchId) ?? 0) + 1);
  const batched = done.filter((j) => j.batchId && runSize.get(j.batchId) >= 2).length;

  const priced = done.filter((j) => revenue(j) != null && driverPay(j) != null);
  const rev = priced.reduce((a, j) => a + revenue(j), 0);
  const pay = priced.reduce((a, j) => a + driverPay(j), 0);
  const parts = { paymentFees: 0, refunds: 0, support: 0, photoCheck: 0 };
  let profitable = 0;
  for (const j of priced) {
    const x = extraCosts(j, costs, queries);
    for (const k of Object.keys(parts)) parts[k] += x[k];
    const cm2 = revenue(j) - driverPay(j) - x.paymentFees - x.refunds - x.support - x.photoCheck;
    if (cm2 > 0) profitable += 1;
  }
  const extra = Object.values(parts).reduce((a, b) => a + b, 0);

  // Quality, from the query log: a perfect order is on time (by the promise)
  // with no missing, wrong or damaged item reported.
  const qualityHit = (j) => (queries.get(j.id) ?? []).some((q) => isQuality(q.type));
  const onTime = (j) => j.promiseAt && j.completedAt <= j.promiseAt;
  const queryCount = done.reduce((a, j) => a + (queries.get(j.id)?.length ?? 0), 0);

  return {
    orders: list.length, delivered: done.length, failed: list.filter((j) => j.status === 'FAILED').length,
    within30: share(within30, mins.length),
    breaches: share(mins.length - within30, mins.length),
    withinSla: share(onSla, done.length),
    avgMinutes: round(avg(mins)),
    avgWait: round(avg(waits)), p90Wait: round(pct(waits, 0.9)),
    waitOver5: share(waits.filter((w) => w > 5).length, waits.length),
    batching: share(batched, done.length),
    fad: share(finished.filter(firstTry).length, finished.length),
    avgKm: round(avg(kms)), maxKm: round(kms.length ? Math.max(...kms) : null),
    over7km: share(kms.filter((k) => k > 7).length, kms.length),
    revenuePerOrder: priced.length ? round(rev / priced.length, 2) : null,
    driverPayPerOrder: priced.length ? round(pay / priced.length, 2) : null,
    cm1PerOrder: priced.length ? round((rev - pay) / priced.length, 2) : null,
    cm1Total: round(rev - pay, 2),
    cm2PerOrder: priced.length ? round((rev - pay - extra) / priced.length, 2) : null,
    cm2Total: round(rev - pay - extra, 2),
    costParts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, priced.length ? round(v / priced.length, 2) : null])),
    profitable, profitableShare: share(profitable, priced.length),
    qaErrorRate: share(done.filter(qualityHit).length, done.length),
    por: share(done.filter((j) => onTime(j) && !qualityHit(j)).length, done.length),
    queriesPer100: done.length ? round((queryCount / done.length) * 100, 1) : null,
    priced: priced.length,
  };
}

/**
 * @param jobs     every order created since `sinceMs` (any status)
 * @param zone     only this zone (optional)
 * @param storeId  only this store (optional)
 */
/**
 * @param costs        CM2 costs (perfSettings.js): { values, set }
 * @param onlineHours  driver hours online in the window (same zone filter)
 * @param queries      support queries in the window: [{ jobId, refund }]
 */
export function performance(jobs, { sinceMs, now = Date.now(), zone = null, storeId = null,
  costs = null, onlineHours = null, queries = [] } = {}) {
  const inScope = jobs.filter((j) => j.createdAt >= sinceMs
    && (!zone || j.zone === zone) && (!storeId || j.storeId === storeId));
  const cv = { ...DEFAULT_COSTS, ...(costs?.values ?? {}) };
  const byJob = new Map();
  for (const q of queries) if (q.jobId) byJob.set(q.jobId, [...(byJob.get(q.jobId) ?? []), q]);
  const c = core(inScope, cv, byJob);
  const scopedIds = new Set(inScope.map((j) => j.id));
  // Queries about these orders; with no store or zone filter, also those not tied to an order.
  const qs = queries.filter((q) => (q.jobId ? scopedIds.has(q.jobId) : !zone && !storeId));
  const days = Math.max(1, (now - sinceMs) / 86400000);

  const byZone = [...new Set(inScope.map((j) => j.zone ?? '(no zone)'))].sort().map((z) => {
    const k = core(inScope.filter((j) => (j.zone ?? '(no zone)') === z));
    return { zone: z, ...k, breachStatus: rate(k.breaches, TARGETS.zoneBreaches) };
  });
  const byDistance = DISTANCE_BANDS.map((b) => {
    const k = core(inScope.filter((j) => j.distanceKm != null && j.distanceKm >= b[0] && j.distanceKm < b[1]));
    return { band: bandLabel(b), orders: k.delivered, within30: k.within30, breaches: k.breaches,
      breachStatus: rate(k.breaches, TARGETS.zoneBreaches) };
  });

  // Week by week, newest last.
  const weeks = [];
  for (let end = now; end > sinceMs; end -= 7 * 86400000) {
    const start = Math.max(sinceMs, end - 7 * 86400000);
    const k = core(inScope.filter((j) => j.createdAt >= start && j.createdAt < end));
    weeks.unshift({ from: start, to: end, delivered: k.delivered, within30: k.within30, withinSla: k.withinSla,
      avgWait: k.avgWait, batching: k.batching, fad: k.fad, cm1PerOrder: k.cm1PerOrder,
      por: k.por, qaErrorRate: k.qaErrorRate, queriesPer100: k.queriesPer100 });
  }

  return {
    window: { since: sinceMs, days: round(days), zone, storeId },
    zones: [...new Set(jobs.map((j) => j.zone).filter(Boolean))].sort(),
    stores: [...new Set(jobs.map((j) => j.storeId).filter(Boolean))].sort(),
    volume: { orders: c.orders, delivered: c.delivered, failed: c.failed,
      perMonth: round((c.delivered / days) * 30, 0) },
    core: {
      speed: metric(c.within30, 'within30', { label: '% delivered within 30 min of order' }),
      quality: { value: c.por, unit: 'share', label: 'Perfect order rate',
        note: 'on time, no missing, wrong or damaged item reported' },
      gmv: { value: null, label: 'GMV run rate', waiting: 'Needs the basket total from Keychat: step 4.' },
      margin: { value: c.cm1PerOrder, label: 'Contribution margin per order (CM1)', unit: 'R',
        note: `R${PLATFORM_FEE} + delivery fee, minus driver pay` },
      matu: { value: null, label: 'Monthly transacting users', waiting: 'Needs a customer id from Keychat: step 4.' },
    },
    metrics: {
      within30: metric(c.within30, 'within30'),
      withinSla: { value: c.withinSla, unit: 'share', note: 'delivered by the promised time' },
      zoneBreaches: metric(c.breaches, 'zoneBreaches'),
      driverWait: metric(c.avgWait, 'driverWait', { p90: c.p90Wait, over5: c.waitOver5 }),
      batching: metric(c.batching, 'batching'),
      fad: metric(c.fad, 'fad'),
      distance: metric(c.maxKm, 'maxDistance', { avg: c.avgKm }),
      over7km: metric(c.over7km, 'over7km'),
      avgMinutes: { value: c.avgMinutes, unit: 'min', note: 'order to delivered' },
      revenuePerOrder: { value: c.revenuePerOrder, unit: 'R' },
      driverPayPerOrder: { value: c.driverPayPerOrder, unit: 'R' },
      cm1PerOrder: { value: c.cm1PerOrder, unit: 'R', total: c.cm1Total, priced: c.priced },
      // Store and zone filters narrow the orders but not the hours (a driver
      // isn't online "for" one store), so drops per hour is shown unfiltered by store.
      dropsPerHour: { value: !storeId && onlineHours ? round(c.delivered / onlineHours, 2) : null, unit: 'num',
        hours: onlineHours != null ? round(onlineHours, 1) : null },
      cm2PerOrder: { value: c.cm2PerOrder, unit: 'R', total: c.cm2Total, parts: c.costParts,
        unset: Object.keys(COST_SETTINGS).filter((k) => costs && !costs.set?.[k]) },
      profitableOrders: { value: round((c.profitable / days) * 30, 0), unit: 'num', share: c.profitableShare,
        note: 'orders a month with CM2 above zero' },
    },
    qa: qaSection(inScope, qs, byJob, cv, c),
    waiting: [
      { metric: 'GMV run rate, MATU', why: 'Needs the basket total and a customer id from Keychat: step 4.' },
    ],
    byZone, byDistance, weeks,
  };
}

/**
 * QA: the query log, and whether the AI photo check pays for itself.
 *
 * Checked and unchecked orders are compared on what quality problems cost
 * after delivery (refunds plus support time for missing, wrong or damaged
 * items). The check pays off when that cost falls by more than the check
 * costs. Selective stores check bigger orders and new drivers, so the two
 * groups are not identical: read the gap with that in mind.
 */
function qaSection(list, qs, byJob, costs, c) {
  const done = list.filter((j) => j.status === 'DELIVERED' && j.completedAt);
  const byType = Object.entries(QUERY_TYPES).map(([type, t]) => {
    const of = qs.filter((q) => q.type === type);
    return { type, label: t.label, quality: t.quality, count: of.length,
      per100: done.length ? round((of.filter((q) => q.jobId).length / done.length) * 100, 1) : null,
      refunds: round(of.reduce((a, q) => a + (q.refund ?? 0), 0), 2) };
  });
  const quality = qs.filter((q) => isQuality(q.type));
  const costOf = (q) => (q.refund ?? 0) + costs.supportCostPerQuery;
  const costPerQualityQuery = quality.length ? quality.reduce((a, q) => a + costOf(q), 0) / quality.length : null;

  const ran = (j) => j.photoCheck?.usage || ['complete', 'missing', 'different', 'unclear'].includes(j.photoCheck?.status);
  const group = (orders) => {
    const qq = orders.flatMap((j) => (byJob.get(j.id) ?? []).filter((q) => isQuality(q.type)));
    const checkCost = orders.reduce((a, j) => a + (j.photoCheck?.usage ? checkCost$(j) * costs.usdZar : 0), 0);
    return {
      orders: orders.length,
      qualityPer100: orders.length ? round((qq.length / orders.length) * 100, 1) : null,
      qualityCostPerOrder: orders.length ? round(qq.reduce((a, q) => a + costOf(q), 0) / orders.length, 2) : null,
      checkCostPerOrder: orders.length ? round(checkCost / orders.length, 2) : null,
      caughtAtStore: orders.filter((j) => ['missing', 'different'].includes(j.photoCheck?.status)).length,
    };
  };
  const checked = group(done.filter(ran));
  const unchecked = group(done.filter((j) => !ran(j)));
  const enough = checked.orders >= 20 && unchecked.orders >= 20;
  const saving = checked.orders && unchecked.orders
    ? round(unchecked.qualityCostPerOrder - checked.qualityCostPerOrder - checked.checkCostPerOrder, 2) : null;
  return {
    queries: qs.length, qualityQueries: quality.length,
    calls: qs.filter((q) => q.channel === 'call').length,
    refunds: round(qs.reduce((a, q) => a + (q.refund ?? 0), 0), 2),
    qaErrorRate: { value: c.qaErrorRate, unit: 'share', note: 'delivered orders with a missing, wrong or damaged item reported' },
    queriesPer100: { value: c.queriesPer100, unit: 'num', note: 'support queries per 100 delivered orders' },
    por: { value: c.por, unit: 'share', note: 'on time, no missing, wrong or damaged item reported' },
    byType,
    photoCheck: {
      checked, unchecked, enough,
      costPerQualityQuery: round(costPerQualityQuery, 2),
      // Quality queries the check must prevent, per 100 orders, to cover its own cost.
      breakEvenPer100: costPerQualityQuery && checked.checkCostPerOrder != null
        ? round((checked.checkCostPerOrder / costPerQualityQuery) * 100, 2) : null,
      savingPerCheckedOrder: saving,
      paysOff: saving == null ? null : saving > 0,
    },
    recent: qs.slice(0, 50),
  };
}
const checkCost$ = (j) => checkCost(j.photoCheck.usage, j.photoCheck.model);
