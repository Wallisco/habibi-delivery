/**
 * Back-office metrics.
 *
 * The four questions an operator has to answer daily, and the fifth that
 * decides whether the business works:
 *
 *   PRODUCTIVITY  orders per driver per active hour
 *   QUALITY       on-time rate, proof grades, exceptions
 *   SPEED         where the minutes go, stage by stage
 *   COST          cost to serve, per order and in total
 *   MERCHANTS     which kitchens are burning driver time
 *
 * That last one is the asset. Uber Eats and Mr D both hold this data and
 * neither acts on it -- our analysis of 92,000 of their orders found a tenfold
 * spread in courier wait between stores of the same brand, unpriced. A store
 * leaderboard is the single most commercially useful report here.
 *
 * Everything is computed from SQLite on demand. At a zone's volume that is
 * milliseconds; move to materialised rollups when a query starts to hurt.
 */

const MIN = 60000;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round = (v, d = 1) => (v == null ? null : Number(v.toFixed(d)));

export class Metrics {
  constructor(db) { this.db = db; }

  jobsSince(sinceMs) {
    return this.db.sql.prepare(`
      SELECT payload FROM jobs WHERE created_at >= ? ORDER BY created_at
    `).all(sinceMs).map((r) => JSON.parse(r.payload));
  }

  /* ------------------------------------------------------------- summary */

  summary(sinceMs = Date.now() - 7 * 24 * 3600 * 1000) {
    const all = this.jobsSince(sinceMs);
    const done = all.filter((j) => j.status === 'DELIVERED');

    const waits = done.map((j) => this.waitMinutes(j)).filter((v) => v != null);
    const durations = done
      .map((j) => (j.completedAt && j.createdAt ? (j.completedAt - j.createdAt) / MIN : null))
      .filter((v) => v != null);

    const late = done.filter((j) => j.promiseAt && j.completedAt > j.promiseAt).length;
    const grades = {};
    for (const j of done) grades[j.proofGrade ?? 'UNKNOWN'] = (grades[j.proofGrade ?? 'UNKNOWN'] ?? 0) + 1;

    const earnings = done.map((j) => j.earnings).filter(Boolean);
    const platformPay = earnings.reduce((a, e) => a + e.platformFunded, 0);
    const tips = earnings.reduce((a, e) => a + (e.tip ?? 0), 0);

    return {
      window: { since: sinceMs, days: round((Date.now() - sinceMs) / 86400000) },
      volume: {
        created: all.length,
        delivered: done.length,
        open: all.filter((j) => !['DELIVERED', 'CANCELLED', 'FAILED'].includes(j.status)).length,
        failed: all.filter((j) => j.status === 'FAILED').length,
      },
      speed: {
        medianWaitAtStoreMin: round(median(waits)),
        p90WaitAtStoreMin: round(this.pct(waits, 0.9)),
        medianOrderToDeliveredMin: round(median(durations)),
        // The number the whole business turns on. Every minute here is a minute
        // a driver is standing still and not earning.
        totalDriverWaitHours: round(waits.reduce((a, b) => a + b, 0) / 60),
      },
      quality: {
        onTimeRate: done.length ? round(1 - late / done.length, 3) : null,
        proofGrades: grades,
        flagged: done.filter((j) => j.proofGrade === 'FLAGGED').length,
      },
      cost: {
        driverPay: round(platformPay, 2),
        tipsPassedThrough: round(tips, 2),
        costPerOrder: done.length ? round(platformPay / done.length, 2) : null,
        // Tips are the customer's money. Including them would flatter the
        // driver's apparent pay and understate what we actually fund.
        driverEarningsPerOrder: done.length ? round((platformPay + tips) / done.length, 2) : null,
      },
    };
  }

  pct(xs, p) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  }

  waitMinutes(j) {
    if (j.readyAt && j.collectedAt) return (j.collectedAt - j.readyAt) / MIN;
    return null;
  }

  /* --------------------------------------------------------- merchants */

  /**
   * Store leaderboard, ranked by the driver time each kitchen consumes.
   * This is the report you take into a merchant conversation.
   */
  merchants(sinceMs = Date.now() - 30 * 24 * 3600 * 1000) {
    const done = this.jobsSince(sinceMs).filter((j) => j.status === 'DELIVERED');
    const by = new Map();
    for (const j of done) {
      const w = this.waitMinutes(j);
      const e = by.get(j.storeId) ?? { storeId: j.storeId, orders: 0, waits: [], preps: [] };
      e.orders += 1;
      if (w != null) e.waits.push(w);
      if (j.readyAt && j.createdAt) e.preps.push((j.readyAt - j.createdAt) / MIN);
      by.set(j.storeId, e);
    }
    return [...by.values()]
      .map((e) => ({
        storeId: e.storeId,
        orders: e.orders,
        medianPrepMin: round(median(e.preps)),
        medianWaitMin: round(median(e.waits)),
        p90WaitMin: round(this.pct(e.waits, 0.9)),
        driverHoursConsumed: round(e.waits.reduce((a, b) => a + b, 0) / 60, 2),
        // What the wait costs us in delay fees at this store.
        delayFeesPaid: round(e.waits.reduce((a, w) => a + Math.max(0, w - 8) * 1.4, 0), 2),
      }))
      .sort((a, b) => (b.medianWaitMin ?? 0) - (a.medianWaitMin ?? 0));
  }

  /* ----------------------------------------------------------- drivers */

  drivers(sinceMs = Date.now() - 7 * 24 * 3600 * 1000) {
    const done = this.jobsSince(sinceMs).filter((j) => j.status === 'DELIVERED' && j.driverId);
    const by = new Map();
    for (const j of done) {
      const e = by.get(j.driverId) ?? {
        driverId: j.driverId, orders: 0, pay: 0, tips: 0, waits: [], days: new Set(), grades: {},
      };
      e.orders += 1;
      e.pay += j.earnings?.platformFunded ?? 0;
      e.tips += j.earnings?.tip ?? 0;
      const w = this.waitMinutes(j);
      if (w != null) e.waits.push(w);
      e.days.add(new Date(j.completedAt).toISOString().slice(0, 10));
      e.grades[j.proofGrade] = (e.grades[j.proofGrade] ?? 0) + 1;
      by.set(j.driverId, e);
    }
    const reg = this.db.sql.prepare('SELECT id, zone, acceptance_rate FROM drivers').all();
    const meta = new Map(reg.map((r) => [r.id, r]));

    return [...by.values()].map((e) => ({
      driverId: e.driverId,
      zone: meta.get(e.driverId)?.zone ?? null,
      orders: e.orders,
      activeDays: e.days.size,
      ordersPerDay: round(e.orders / Math.max(1, e.days.size)),
      earnings: round(e.pay + e.tips, 2),
      earningsPerDay: round((e.pay + e.tips) / Math.max(1, e.days.size), 2),
      tipShare: e.pay + e.tips > 0 ? round(e.tips / (e.pay + e.tips), 3) : null,
      medianWaitMin: round(median(e.waits)),
      acceptanceRate: round(meta.get(e.driverId)?.acceptance_rate ?? 1, 2),
      // A driver whose grade D rate runs well above their peers is worth a
      // look. Grading every completion gives this for free.
      overrideRate: e.orders ? round((e.grades.D ?? 0) / e.orders, 3) : null,
      flagged: e.grades.FLAGGED ?? 0,
    })).sort((a, b) => b.orders - a.orders);
  }

  /* -------------------------------------------------------- exceptions */

  /** The work queue. Anything a human needs to look at. */
  exceptions(sinceMs = Date.now() - 7 * 24 * 3600 * 1000) {
    const all = this.jobsSince(sinceMs);
    const out = [];
    for (const j of all) {
      if (j.proofGrade === 'FLAGGED') {
        out.push({ jobId: j.id, type: 'PROOF_FLAGGED', driverId: j.driverId,
          detail: 'Offline completion whose GPS trail never entered the geofence' });
      }
      if (j.proofGrade === 'D') {
        out.push({ jobId: j.id, type: 'SUPPORT_OVERRIDE', driverId: j.driverId,
          detail: 'Closed by agent override rather than customer code' });
      }
      if (j.status === 'FAILED') {
        out.push({ jobId: j.id, type: 'FAILED', driverId: j.driverId, detail: 'Delivery not completed' });
      }
      const w = this.waitMinutes(j);
      if (w != null && w > 25) {
        out.push({ jobId: j.id, type: 'LONG_WAIT', driverId: j.driverId,
          detail: `Driver waited ${w.toFixed(0)} min at ${j.storeId}` });
      }
      if (j.status === 'PENDING' && Date.now() - j.createdAt > 45 * MIN) {
        out.push({ jobId: j.id, type: 'STUCK', driverId: null,
          detail: `Unassigned for ${((Date.now() - j.createdAt) / MIN).toFixed(0)} min` });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------ hourly */

  /** Demand by hour. 35% of food volume lands in two hours; plan supply on it. */
  hourly(sinceMs = Date.now() - 7 * 24 * 3600 * 1000) {
    const all = this.jobsSince(sinceMs);
    const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, waits: [] }));
    for (const j of all) {
      const h = new Date(j.createdAt).getHours();
      buckets[h].orders += 1;
      const w = this.waitMinutes(j);
      if (w != null) buckets[h].waits.push(w);
    }
    return buckets.map((b) => ({
      hour: b.hour, orders: b.orders, medianWaitMin: round(median(b.waits)),
    }));
  }
}
