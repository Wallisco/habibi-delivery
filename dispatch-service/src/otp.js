/**
 * Delivery codes.
 *
 * Rules that matter:
 *  - Issued when the driver APPROACHES, not at order time, so the code is fresh
 *    at the top of the customer's notifications.
 *  - Never returned to the driver app in any response. If the driver can see
 *    it, the whole control is theatre.
 *  - Verified server-side against the driver's reported position; entry outside
 *    the geofence is rejected. Without this a driver can phone ahead, collect
 *    the code, and abandon the order at the gate.
 *  - Attempts are capped, then the job escalates to a support override (grade D)
 *    rather than looping.
 */

import { randomInt } from 'node:crypto';
import { metresBetween } from './supply.js';

export class OtpService {
  constructor() { this.byJob = new Map(); }

  /** Returns the code for delivery to the CUSTOMER only. */
  issue(jobId) {
    const existing = this.byJob.get(jobId);
    if (existing) return existing.code;
    const code = String(randomInt(1000, 10000));
    this.byJob.set(jobId, { code, attempts: 0, issuedAt: Date.now(), resends: 0 });
    return code;
  }

  resend(jobId) {
    const rec = this.byJob.get(jobId);
    if (!rec) return null;
    if (rec.resends >= 3) return { throttled: true };
    rec.resends += 1;
    return { code: rec.code, resends: rec.resends };
  }

  attempts(jobId) { return this.byJob.get(jobId)?.attempts ?? 0; }

  /**
   * Read the live code without consuming an attempt.
   *
   * For the back office only. A support agent on the phone to a customer who
   * cannot find their code needs to read it out, and that is a legitimate
   * operation. It must never be reachable from a driver-facing route -- the
   * whole control depends on the driver not knowing the code.
   */
  peek(jobId) {
    const rec = this.byJob.get(jobId);
    if (!rec) return null;
    return { code: rec.code, attempts: rec.attempts, resends: rec.resends,
      issuedAt: rec.issuedAt };
  }

  verify(jobId, code, { position, job }) {
    const rec = this.byJob.get(jobId);
    if (!rec) return { verified: false, reason: 'No code issued for this delivery' };

    const metres = metresBetween(position, job.dropoff);
    if (metres > job.proofPolicy.geofenceMetres) {
      return {
        verified: false,
        outsideGeofence: true,
        reason: `You are ${Math.round(metres)} m from the drop-off. Move closer to complete.`,
      };
    }

    if (rec.attempts >= job.proofPolicy.otpAttemptLimit) {
      return { verified: false, exhausted: true, reason: 'Too many attempts. Contact support.' };
    }

    rec.attempts += 1;
    if (rec.code !== code) {
      return {
        verified: false,
        attemptsLeft: job.proofPolicy.otpAttemptLimit - rec.attempts,
        reason: 'That code did not match.',
      };
    }
    this.byJob.delete(jobId);
    return { verified: true };
  }
}
