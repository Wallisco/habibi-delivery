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

export const DISTANCE_BANDS = [[0, 3], [3, 5], [5, 7], [7, Infinity]];
const bandLabel = ([a, b]) => (b === Infinity ? `${a}+ km` : `${a}–${b} km`);

/** The core numbers for a set of orders (used for the period, each zone, each week). */
function core(list) {
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
    priced: priced.length,
  };
}

/**
 * @param jobs     every order created since `sinceMs` (any status)
 * @param zone     only this zone (optional)
 * @param storeId  only this store (optional)
 */
export function performance(jobs, { sinceMs, now = Date.now(), zone = null, storeId = null } = {}) {
  const inScope = jobs.filter((j) => j.createdAt >= sinceMs
    && (!zone || j.zone === zone) && (!storeId || j.storeId === storeId));
  const c = core(inScope);
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
      avgWait: k.avgWait, batching: k.batching, fad: k.fad, cm1PerOrder: k.cm1PerOrder });
  }

  return {
    window: { since: sinceMs, days: round(days), zone, storeId },
    zones: [...new Set(jobs.map((j) => j.zone).filter(Boolean))].sort(),
    stores: [...new Set(jobs.map((j) => j.storeId).filter(Boolean))].sort(),
    volume: { orders: c.orders, delivered: c.delivered, failed: c.failed,
      perMonth: round((c.delivered / days) * 30, 0) },
    core: {
      speed: metric(c.within30, 'within30', { label: '% delivered within 30 min of order' }),
      quality: { value: null, label: 'Perfect order rate', waiting: 'Needs the query log (missing / damaged items): step 3.' },
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
    },
    waiting: [
      { metric: 'Rider drops per hour', why: 'Needs online hours per driver: step 2.' },
      { metric: 'CM2 and profitable order volume', why: 'Needs payment fees, refunds, support and photo-check cost per order: step 2.' },
      { metric: 'QA error rate, support queries, perfect order rate', why: 'Needs the query log: step 3.' },
      { metric: 'GMV run rate, MATU', why: 'Needs the basket total and a customer id from Keychat: step 4.' },
    ],
    byZone, byDistance, weeks,
  };
}
