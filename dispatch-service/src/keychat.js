/**
 * The Keychat integration, both directions.
 *
 * INBOUND (they call us)
 *   POST /v1/keychat/quote          price an order before checkout
 *   POST /v1/keychat/jobs           create the delivery once the customer pays
 *   POST /v1/keychat/jobs/:id/ready the POS says the order is up
 *   POST /v1/keychat/jobs/:id/cancel
 *
 * OUTBOUND (we call them)
 *   delivery.assigned    a driver took it, with their name and ETA
 *   delivery.collected   left the store
 *   delivery.code_issued the OTP to show the customer  <-- Keychat holds this
 *   delivery.delivered   done, with the final itemised charge
 *   delivery.failed      not completed, with a reason
 *
 * WHO HOLDS WHAT
 * Keychat holds the transaction record and shows the customer their code. We
 * generate and verify it, because verification has to happen against the
 * driver's live position and we are the only party that has it. They display,
 * we adjudicate.
 *
 * Driver management is entirely ours -- onboarding, vetting, state, pay,
 * performance. Keychat never sees a driver record beyond the first name and
 * vehicle shown to a customer tracking their order.
 */

const KEYCHAT_URL = process.env.KEYCHAT_WEBHOOK_URL ?? null;
const KEYCHAT_SECRET = process.env.KEYCHAT_SECRET ?? null;
const TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 5;

/**
 * Outbound queue.
 *
 * Deliveries retry with backoff and survive a restart, because a missed
 * `delivery.delivered` means Keychat never closes the order and never pays us
 * for it. Failures here are silent revenue loss, which is the worst kind.
 */
export class KeychatClient {
  constructor(db = null, { log = null } = {}) {
    this.db = db;
    this.log = log;
    this.queue = [];
    this.timer = null;
    this.configured = Boolean(KEYCHAT_URL);
  }

  /** Every event is recorded whether or not a webhook is configured. */
  emit(type, payload) {
    const event = {
      id: `EVT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      at: Date.now(),
      payload,
      attempts: 0,
      status: this.configured ? 'PENDING' : 'RECORDED',
    };
    this.db?.saveOutboundEvent(event);
    if (this.configured) this.queue.push(event);
    return event;
  }

  start(intervalMs = 4000) {
    if (!this.configured || this.timer) return;
    this.timer = setInterval(() => this.drain(), intervalMs);
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async drain() {
    if (!this.queue.length) return { sent: 0, failed: 0 };
    const batch = this.queue.splice(0, 20);
    let sent = 0, failed = 0;

    for (const e of batch) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(KEYCHAT_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...(KEYCHAT_SECRET ? { 'x-dispatch-signature': KEYCHAT_SECRET } : {}),
            'x-event-id': e.id,
          },
          body: JSON.stringify({ type: e.type, at: e.at, data: e.payload }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        e.status = 'SENT';
        this.db?.saveOutboundEvent(e);
        sent += 1;
      } catch (err) {
        e.attempts += 1;
        // Give up after MAX_ATTEMPTS but keep the row: an event stuck here is
        // an order Keychat has not been billed for, and someone must chase it.
        e.status = e.attempts >= MAX_ATTEMPTS ? 'DEAD' : 'PENDING';
        this.db?.saveOutboundEvent(e);
        if (e.status === 'PENDING') this.queue.push(e);
        failed += 1;
        this.log?.warn?.({ event: e.id, attempts: e.attempts }, 'keychat webhook failed');
      } finally {
        clearTimeout(t);
      }
    }
    return { sent, failed };
  }
}

/**
 * The quote we hand back to Keychat.
 *
 * Two numbers matter and they are deliberately separate:
 *   customerCharge  what they add to the customer's order total
 *   driverCost      what we will pay the driver, itemised
 *
 * The gap is our margin, and showing it means reconciliation is arithmetic
 * rather than a negotiation at month end.
 */
export function buildQuote({ quoteId, job, earnings, routing, etaMinutes, readyGate,
  customerCharge, expiresInSeconds = 180 }) {
  return {
    quoteId,
    expiresInSeconds,
    currency: 'ZAR',

    // What Keychat adds to the customer's order.
    customerCharge: {
      deliveryFee: Number(customerCharge.toFixed(2)),
      tipIsSeparate: true,
      note: 'Tip is collected by Keychat at checkout and passed through in full to the driver.',
    },

    // What the delivery will cost, itemised, for reconciliation.
    driverCost: {
      lines: earnings.lines
        .filter((l) => l.fundedBy === 'platform')
        .map(({ code, label, detail, amount }) => ({ code, label, detail, amount })),
      total: earnings.platformFunded,
    },

    // Our margin on this order, stated rather than implied.
    margin: Number((customerCharge - earnings.platformFunded).toFixed(2)),

    routing: {
      collectKm: routing.collectKm,
      deliverKm: routing.deliverKm,
      drivingMinutes: routing.deliverMinutes,
      source: routing.source,
    },

    timing: {
      etaMinutes,
      // What we will do with the merchant's own prep estimate.
      merchantPrepMinutes: readyGate.merchantPrepMinutes ?? null,
      ourPrepEstimateMinutes: readyGate.predictedPrepMinutes,
      prepSource: readyGate.confidence,
      // When we intend to send a driver, so the merchant can sanity-check it.
      driverDispatchAtMinutes: readyGate.releaseOffsetMinutes,
    },
  };
}

/**
 * Reconciliation statement. What Keychat owes us for a period, per order,
 * with every fee line intact so a dispute lands on one row rather than the
 * whole invoice.
 */
export function buildStatement(jobs, { from, to }) {
  const rows = jobs
    .filter((j) => j.status === 'DELIVERED' && j.completedAt >= from && j.completedAt <= to)
    .map((j) => ({
      jobId: j.id,
      externalId: j.externalId,
      completedAt: j.completedAt,
      storeId: j.storeId,
      zone: j.zone,
      deliverKm: j.distanceKm,
      distanceSource: j.distanceSource,
      customerCharge: j.customerCharge ?? null,
      driverCost: j.earnings?.platformFunded ?? null,
      tipPassedThrough: j.earnings?.tip ?? 0,
      margin: j.customerCharge != null && j.earnings
        ? Number((j.customerCharge - j.earnings.platformFunded).toFixed(2)) : null,
      lines: j.earnings?.lines ?? [],
      proofGrade: j.proofGrade,
    }));

  const sum = (f) => Number(rows.reduce((a, r) => a + (r[f] ?? 0), 0).toFixed(2));
  return {
    period: { from, to },
    orders: rows.length,
    totals: {
      customerCharges: sum('customerCharge'),
      driverCost: sum('driverCost'),
      tipsPassedThrough: sum('tipPassedThrough'),
      margin: sum('margin'),
    },
    rows,
  };
}
