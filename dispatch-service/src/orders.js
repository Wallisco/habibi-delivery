/**
 * Order states and messaging.
 *
 * Every state an order can be in, and the ability for back-office staff to
 * talk to a driver mid-delivery. Both exist for the same reason: when a
 * customer phones about a late order, someone has to be able to see exactly
 * where it is and ask the driver what happened.
 */

/**
 * The full lifecycle. Displayed per order in the back office as a timeline, so
 * "where is my order" is answered by looking rather than by phoning.
 */
export const ORDER_STATES = [
  { code: 'PENDING', label: 'Waiting for the kitchen',
    detail: 'Held by the ready gate until the food is nearly up' },
  { code: 'OFFERED', label: 'Offered to a driver',
    detail: 'A driver has 25 seconds to accept' },
  { code: 'ASSIGNED', label: 'Driver on the way to collect', detail: null },
  { code: 'AT_STORE', label: 'Driver at the restaurant', detail: null },
  { code: 'IN_TRANSIT', label: 'Collected, on the way', detail: null },
  { code: 'AT_CUSTOMER', label: 'Driver at the door',
    detail: 'Customer code issued' },
  { code: 'DELIVERED', label: 'Delivered', detail: 'Customer entered their code' },
  { code: 'FAILED', label: 'Not delivered', detail: null },
  { code: 'CANCELLED', label: 'Cancelled', detail: null },
];

export const STATE_LABEL = Object.fromEntries(
  ORDER_STATES.map((s) => [s.code, s.label]));

const TERMINAL = new Set(['DELIVERED', 'FAILED', 'CANCELLED']);
export const isTerminal = (s) => TERMINAL.has(s);

/**
 * Build a timeline for one order: every state it passed through, when, and how
 * long it sat there. The dwell time is the useful column -- it shows a support
 * agent instantly whether the delay was the kitchen, the dispatch, or the road.
 */
export function timeline(job) {
  const events = [];
  const push = (code, at, meta = null) => {
    if (at != null) events.push({ code, label: STATE_LABEL[code] ?? code, at, meta });
  };

  push('PENDING', job.createdAt, job.merchantPrepMinutes
    ? `merchant estimated ${job.merchantPrepMinutes} min` : null);
  for (const h of job.history ?? []) {
    if (h.to === 'OFFERED') push('OFFERED', h.at);
    if (h.to === 'ASSIGNED') push('ASSIGNED', h.at, job.driverId ? `driver ${job.driverId}` : null);
  }
  push('AT_STORE', job.readyAt, 'merchant marked the order ready');
  push('IN_TRANSIT', job.collectedAt, job.readyAt && job.collectedAt
    ? `waited ${((job.collectedAt - job.readyAt) / 60000).toFixed(1)} min at the store` : null);
  push('AT_CUSTOMER', job.codeIssuedAt, 'code sent to the customer');
  push('DELIVERED', job.completedAt, job.proofGrade ? `proof grade ${job.proofGrade}` : null);
  if (job.status === 'FAILED') push('FAILED', job.failedAt ?? job.completedAt, job.failReason);

  events.sort((a, b) => a.at - b.at);
  return events.map((e, i) => ({
    ...e,
    dwellMinutes: i < events.length - 1
      ? Number(((events[i + 1].at - e.at) / 60000).toFixed(1)) : null,
  }));
}

/**
 * Messaging.
 *
 * Ops to driver, and back. Threaded per driver, optionally pinned to an order
 * so a question about a specific delivery carries its context. Unread counts
 * exist because a driver on a bike will not see a message until they stop.
 */
export class Messages {
  constructor(db = null) {
    this.db = db;
    this.byDriver = new Map();
  }

  hydrate(rows) {
    for (const m of rows) {
      const list = this.byDriver.get(m.driverId) ?? [];
      list.push(m);
      this.byDriver.set(m.driverId, list);
    }
    return rows.length;
  }

  send({ driverId, from, body, jobId = null, actor = null }) {
    const msg = {
      id: `MSG-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      driverId: String(driverId),
      from,                 // 'ops' | 'driver'
      actor,                // which staff member, when from ops
      body: String(body).slice(0, 1000),
      jobId,
      at: Date.now(),
      readAt: null,
    };
    const list = this.byDriver.get(msg.driverId) ?? [];
    list.push(msg);
    this.byDriver.set(msg.driverId, list);
    this.db?.saveMessage(msg);
    return msg;
  }

  thread(driverId, limit = 100) {
    return (this.byDriver.get(String(driverId)) ?? []).slice(-limit);
  }

  /** Messages a driver has not yet seen. Drives the badge in the app. */
  unreadFor(driverId) {
    return this.thread(driverId).filter((m) => m.from === 'ops' && !m.readAt);
  }

  markRead(driverId, upToId = null) {
    const list = this.thread(driverId, 1000);
    let n = 0;
    for (const m of list) {
      if (m.from !== 'ops' || m.readAt) continue;
      m.readAt = Date.now();
      this.db?.saveMessage(m);
      n += 1;
      if (upToId && m.id === upToId) break;
    }
    return n;
  }

  /** Ops inbox: every driver with something outstanding, busiest first. */
  inbox() {
    const out = [];
    for (const [driverId, list] of this.byDriver) {
      const last = list[list.length - 1];
      const unrepliedFromDriver = [...list].reverse()
        .findIndex((m) => m.from === 'ops') !== 0 && last?.from === 'driver';
      out.push({
        driverId,
        lastMessage: last?.body ?? '',
        lastFrom: last?.from,
        lastAt: last?.at,
        unreadByDriver: list.filter((m) => m.from === 'ops' && !m.readAt).length,
        awaitingOpsReply: unrepliedFromDriver,
        total: list.length,
      });
    }
    return out.sort((a, b) => (b.awaitingOpsReply - a.awaitingOpsReply) || (b.lastAt - a.lastAt));
  }
}

/** Canned messages, because ops staff type the same five things all day. */
export const QUICK_REPLIES = [
  'Are you still at the restaurant?',
  'The customer says they cannot find you.',
  'Please call the customer on the number in the app.',
  'Leave it at reception and take a photo.',
  'Head back to your zone when you finish this one.',
  'Thanks, all sorted on our side.',
];
