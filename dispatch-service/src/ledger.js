/**
 * Driver vehicle ledger.
 *
 * A driver pays R900 a week for the bike and access to jobs. Charging that as
 * a lump on a Monday is brutal on someone earning daily, so it accrues per
 * working day — R900 / 7 = R128.57 — and is settled against what they earn.
 *
 * WHY THIS IS A LEDGER AND NOT A FIELD
 * A driver who has a bad week owes the difference, and that carries. A single
 * "balance" number cannot answer the only questions that matter when they
 * dispute it: what was I charged, when, and what did I pay? Every movement is
 * a row, and the balance is derived from the rows rather than stored.
 *
 * XERO
 * Xero is the system of record for what a driver has actually paid — cash,
 * EFT, deductions handled off-platform. We accrue here and import settlements
 * from there, matched on driver ID. `importPayments` is the seam; nothing else
 * in the service needs to know Xero exists.
 */

export const WEEKLY_VEHICLE_FEE = 900;
export const DAYS_PER_WEEK = 7;
export const DAILY_ACCRUAL = Number((WEEKLY_VEHICLE_FEE / DAYS_PER_WEEK).toFixed(2));

export const ENTRY = {
  ACCRUAL: 'ACCRUAL',       // the daily vehicle and access charge
  PAYMENT: 'PAYMENT',       // money received, usually via Xero
  DEDUCTION: 'DEDUCTION',   // taken from earnings before payout
  ADJUSTMENT: 'ADJUSTMENT', // a credit or correction made by ops
};

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

export class Ledger {
  constructor(db = null) {
    this.db = db;
    this.byDriver = new Map();
  }

  hydrate(rows) {
    for (const e of rows) {
      const list = this.byDriver.get(e.driverId) ?? [];
      list.push(e);
      this.byDriver.set(e.driverId, list);
    }
    return rows.length;
  }

  entries(driverId) { return this.byDriver.get(String(driverId)) ?? []; }

  add({ driverId, type, amount, note = null, day = null, ref = null, actor = 'system' }) {
    const e = {
      id: `LED-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      driverId: String(driverId),
      type,
      // Charges are positive, money in is negative. The balance is then a
      // plain sum, and a driver reading the statement sees the same arithmetic.
      amount: Number(Number(amount).toFixed(2)),
      note,
      day: day ?? dayKey(Date.now()),
      ref,
      actor,
      at: Date.now(),
    };
    const list = this.entries(e.driverId);
    list.push(e);
    this.byDriver.set(e.driverId, list);
    this.db?.saveLedgerEntry(e);
    return e;
  }

  /**
   * Charge a driver for one day. Idempotent per day: running this twice, or
   * restarting mid-shift, must not double-charge someone for the same Tuesday.
   */
  accrueDay(driverId, day = dayKey(Date.now())) {
    const already = this.entries(driverId)
      .some((e) => e.type === ENTRY.ACCRUAL && e.day === day);
    if (already) return null;
    return this.add({
      driverId, type: ENTRY.ACCRUAL, amount: DAILY_ACCRUAL, day,
      note: `Vehicle and job access, ${day}`,
    });
  }

  /** Charge every driver who worked today. Called after each completed job. */
  accrueForActiveDrivers(driverIds, day = dayKey(Date.now())) {
    let n = 0;
    for (const id of new Set(driverIds)) if (this.accrueDay(id, day)) n += 1;
    return n;
  }

  balance(driverId) {
    const list = this.entries(driverId);
    const sum = (t) => list.filter((e) => e.type === t)
      .reduce((a, e) => a + e.amount, 0);

    const accrued = sum(ENTRY.ACCRUAL);
    const paid = Math.abs(sum(ENTRY.PAYMENT)) + Math.abs(sum(ENTRY.DEDUCTION));
    const adjustments = sum(ENTRY.ADJUSTMENT);
    const owing = Number((accrued + adjustments - paid).toFixed(2));

    return {
      driverId: String(driverId),
      accrued: Number(accrued.toFixed(2)),
      paid: Number(paid.toFixed(2)),
      adjustments: Number(adjustments.toFixed(2)),
      owing,
      dailyRate: DAILY_ACCRUAL,
      weeklyRate: WEEKLY_VEHICLE_FEE,
      daysCharged: list.filter((e) => e.type === ENTRY.ACCRUAL).length,
      // Roughly how far behind they are. Useful as a warning, not a rule --
      // a driver two days behind after a rainy week is not the same as one
      // two weeks behind.
      daysBehind: owing > 0 ? Number((owing / DAILY_ACCRUAL).toFixed(1)) : 0,
      lastEntryAt: list.length ? list[list.length - 1].at : null,
    };
  }

  /** This week's position, which is what a driver actually looks at. */
  weekToDate(driverId, now = Date.now()) {
    const monday = new Date(now);
    const back = (monday.getDay() + 6) % 7;
    monday.setDate(monday.getDate() - back);
    monday.setHours(0, 0, 0, 0);

    const list = this.entries(driverId).filter((e) => e.at >= monday.getTime());
    const sum = (t) => list.filter((e) => e.type === t).reduce((a, e) => a + e.amount, 0);
    const charged = sum(ENTRY.ACCRUAL);
    const settled = Math.abs(sum(ENTRY.PAYMENT)) + Math.abs(sum(ENTRY.DEDUCTION));

    return {
      weekStarting: monday.toISOString().slice(0, 10),
      daysCharged: list.filter((e) => e.type === ENTRY.ACCRUAL).length,
      charged: Number(charged.toFixed(2)),
      settled: Number(settled.toFixed(2)),
      outstandingThisWeek: Number((charged - settled).toFixed(2)),
      weeklyRate: WEEKLY_VEHICLE_FEE,
      dailyRate: DAILY_ACCRUAL,
    };
  }

  /**
   * A statement a driver can be sent. Every movement, oldest first, with a
   * running balance beside each — so a dispute lands on one line rather than
   * on the total.
   */
  statement(driverId, { from = 0, to = Date.now() } = {}) {
    const list = this.entries(driverId)
      .filter((e) => e.at >= from && e.at <= to)
      .sort((a, b) => a.at - b.at);

    const opening = this.entries(driverId)
      .filter((e) => e.at < from)
      .reduce((a, e) => a + e.amount, 0);

    let running = opening;
    const lines = list.map((e) => {
      running += e.amount;
      return {
        date: e.day,
        type: e.type,
        description: e.note ?? e.type,
        charge: e.amount > 0 ? e.amount : null,
        payment: e.amount < 0 ? Math.abs(e.amount) : null,
        balance: Number(running.toFixed(2)),
        ref: e.ref,
      };
    });

    return {
      driverId: String(driverId),
      period: { from, to },
      openingBalance: Number(opening.toFixed(2)),
      closingBalance: Number(running.toFixed(2)),
      totalCharged: Number(list.filter((e) => e.amount > 0)
        .reduce((a, e) => a + e.amount, 0).toFixed(2)),
      totalPaid: Number(Math.abs(list.filter((e) => e.amount < 0)
        .reduce((a, e) => a + e.amount, 0)).toFixed(2)),
      lines,
    };
  }

  /**
   * Import settlements from Xero.
   *
   * Matched on `ref` so re-importing the same export does not double-credit a
   * driver — the most likely and most damaging mistake in this whole flow.
   *
   * @param rows [{ driverId, amount, date, reference }]
   */
  importPayments(rows, { actor = 'xero' } = {}) {
    let imported = 0, skipped = 0;
    for (const r of rows ?? []) {
      const ref = String(r.reference ?? '').trim();
      if (!ref) { skipped += 1; continue; }
      const seen = this.entries(r.driverId).some((e) => e.ref === ref);
      if (seen) { skipped += 1; continue; }
      this.add({
        driverId: r.driverId,
        type: ENTRY.PAYMENT,
        amount: -Math.abs(Number(r.amount)),
        note: `Payment received (${ref})`,
        day: r.date ?? dayKey(Date.now()),
        ref,
        actor,
      });
      imported += 1;
    }
    return { imported, skipped };
  }

  /** Everyone's position, for the back office. Worst first. */
  allBalances(driverIds) {
    return [...new Set(driverIds)]
      .map((id) => this.balance(id))
      .sort((a, b) => b.owing - a.owing);
  }
}
