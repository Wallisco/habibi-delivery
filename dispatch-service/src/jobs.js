/**
 * Job store. In-memory here; the interface is the seam for Postgres.
 *
 * Every order, whatever the vertical, normalises into this shape before it
 * touches dispatch. The dispatcher never learns what a burrito is.
 */

import { randomUUID } from 'node:crypto';
import { metresBetween, DETOUR_FACTOR } from './supply.js';
import { orderNumber } from './accounts.js';

export const PROOF_GRADE = { A: 'A', B: 'B', C: 'C', D: 'D' };
export const GRADE_ORDER = { A: 4, B: 3, C: 2, D: 1 };

export const DELIVERY_MODE = {
  HANDOFF_REQUIRED: 'HANDOFF_REQUIRED',
  LEAVE_AT_DOOR: 'LEAVE_AT_DOOR',
  LEAVE_WITH_CONCIERGE: 'LEAVE_WITH_CONCIERGE',
};

/**
 * Reject timestamps that cannot be real.
 *
 * An order from before 2020, or more than a day in the future, is a caller
 * mistake rather than a genuine backdate. Silently accepting one means the
 * order vanishes from every report that filters on a date range, which is far
 * harder to diagnose than a wrong-looking timestamp.
 */
const EARLIEST = Date.UTC(2020, 0, 1);
export function sensibleTimestamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < EARLIEST || n > Date.now() + 86400000) return Date.now();
  return n;
}

export class JobStore {
  constructor(db = null) { this.byId = new Map(); this.db = db; }

  /** Restore live jobs on boot. Delivered jobs stay on disk. */
  hydrate(jobs) {
    for (const j of jobs) this.byId.set(j.id, j);
    return jobs.length;
  }

  create(input) {
    const id = input.id ?? `JOB-${randomUUID().slice(0, 8)}`;
    const job = {
      id,
      // Human-readable, in the incumbents' format, so support staff and drivers
      // can read one out over the phone.
      orderNumber: input.orderNumber ?? orderNumber(input.vertical ?? 'FOOD'),
      externalId: input.externalId ?? null,     // Keychat's order id
      kind: input.kind ?? 'ZONE',               // ZONE | ROAMING | BACKHAUL
      vertical: input.vertical ?? 'FOOD',
      status: 'PENDING',
      // A timestamp, not a flag.
      //
      // `createdAt: 0` was being taken literally and dating orders to 1970,
      // which quietly removed them from every recent-window query. Anything
      // implausible is treated as now; to make an order dispatchable
      // immediately, send `dispatchNow: true` instead.
      createdAt: sensibleTimestamp(input.createdAt),
      promiseAt: input.promiseAt ?? Date.now() + 45 * 60000,
      zone: input.zone ?? null,
      storeId: input.storeId,
      pickup: input.pickup,
      dropoff: input.dropoff,
      bagCount: input.bagCount ?? 1,
      itemCount: input.itemCount ?? 1,

      // Road distance. Keychat routes the order for its own ETA, so we take
      // their number when they send it rather than paying a routing API to
      // recompute what the demand partner already knows. The straight-line
      // fallback applies a detour factor and is only used when they do not.
      collectKm: input.collectKm != null ? Number(input.collectKm) : null,
      distanceKm: input.deliverKm != null
        ? Number(input.deliverKm)
        : Number(((metresBetween(input.pickup, input.dropoff) / 1000) * DETOUR_FACTOR).toFixed(2)),
      distanceSource: input.deliverKm != null ? 'navigation' : 'estimated',

      // The customer commits a tip at checkout, before the job is offered. It
      // is therefore not an estimate, and the driver can be shown a real
      // all-in number rather than a base fee and a hope.
      tip: Number(input.tip ?? 0),

      // The merchant's own prep estimate, from their POS via Keychat. A prior
      // for a store we have no history on, nothing more.
      // dispatchNow zeroes the predicted prep so the ready gate releases the
      // job at once. For testing, and honest about what it is doing.
      merchantPrepMinutes: input.dispatchNow ? 0
        : (input.prepMinutes != null ? Number(input.prepMinutes) : null),
      dispatchNow: Boolean(input.dispatchNow),
      expectedReadyAt: input.expectedReadyAt ?? null,

      // What Keychat charged the customer for delivery, so reconciliation is
      // arithmetic rather than a negotiation.
      customerCharge: input.customerCharge != null ? Number(input.customerCharge) : null,
      quoteId: input.quoteId ?? null,
      fee: input.fee ?? 35,
      requiredCapabilities: input.requiredCapabilities ?? [],
      deliveryMode: input.deliveryMode ?? DELIVERY_MODE.HANDOFF_REQUIRED,
      proofPolicy: {
        minGrade: input.ageRestricted ? PROOF_GRADE.B : PROOF_GRADE.C,
        geofenceMetres: 150,
        otpAttemptLimit: 4,
        doorstepTimerSeconds: 300,
        ...(input.proofPolicy ?? {}),
      },
      driverId: null,
      readyAt: null,        // set by the merchant POS print event
      collectedAt: null,
      completedAt: null,
      proofGrade: null,
      history: [],
    };
    this.byId.set(id, job);
    this.db?.saveJob(job);
    return job;
  }

  get(id) { return this.byId.get(id); }
  all() { return [...this.byId.values()]; }
  pending() { return this.all().filter((j) => j.status === 'PENDING'); }
  pendingInZone(zone) { return this.pending().filter((j) => j.zone === zone); }

  setStatus(id, status, patch = {}) {
    const j = this.byId.get(id);
    if (!j) return null;
    j.history.push({ at: Date.now(), from: j.status, to: status });
    Object.assign(j, patch, { status });
    this.db?.saveJob(j);
    return j;
  }

  /**
   * The merchant's label printer firing is the ready signal. This timestamp is
   * uncensored, unlike the driver's collection scan, and it is what the ready
   * gate learns from. Neither Uber Eats nor Mr D collect it.
   */
  markReady(id, at = Date.now()) {
    const j = this.byId.get(id);
    if (!j || j.readyAt) return null;
    j.readyAt = at;
    this.db?.saveJob(j);
    return j;
  }
}
