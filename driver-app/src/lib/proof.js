/**
 * Proof of delivery.
 *
 * Every delivery closes by producing a proof artifact of some grade. The
 * failure modes are rungs on a ladder, not exceptions bolted onto a happy
 * path -- which is what stops "customer didn't answer" turning into a support
 * ticket every time.
 *
 *   A  OTP verified online, inside the geofence          full confidence
 *   B  OTP verified offline, synced later                payout held
 *   C  Photo + geofence, pre-authorised leave-at-door    evidence based
 *   D  Support override, agent recorded                  human in the loop
 *
 * The vertical sets a FLOOR via minGrade. That is what stops a bottle of wine
 * or a cash-on-delivery parcel closing on a doorstep photo.
 */

export const GRADE = { A: 'A', B: 'B', C: 'C', D: 'D' };
const ORDER = { A: 4, B: 3, C: 2, D: 1 };

export function meetsFloor(grade, minGrade) {
  return ORDER[grade] >= ORDER[minGrade];
}

export const DELIVERY_MODE = {
  HANDOFF_REQUIRED: 'HANDOFF_REQUIRED',
  LEAVE_AT_DOOR: 'LEAVE_AT_DOOR',
  LEAVE_WITH_CONCIERGE: 'LEAVE_WITH_CONCIERGE',
};

/**
 * The single most important rule in the whole design: the driver can never
 * choose leave-at-door at the door. If they could, you have built an incentive
 * to abandon food and mark it delivered. The mode is set at checkout by the
 * customer, and only the customer can change it mid-flight.
 */
export function driverMaySwitchToLeaveAtDoor() {
  return false;
}

const EARTH_M = 6371000;

export function metresBetween(a, b) {
  if (!a || !b) return Infinity;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_M * Math.asin(Math.sqrt(h));
}

export function insideGeofence(position, target, radiusM) {
  return metresBetween(position, target) <= radiusM;
}

/**
 * Decide what proof this delivery can close on, right now.
 * Returns the actions the UI should offer, in priority order.
 */
export function availableProofActions({ job, position, online, otpAttempts }) {
  const inFence = insideGeofence(position, job.dropoff, job.proofPolicy.geofenceMetres);
  const actions = [];

  if (!inFence) {
    return {
      inFence: false,
      actions: [],
      blocker: `Move closer to the drop-off to complete. You need to be within ${job.proofPolicy.geofenceMetres} m.`,
    };
  }

  const attemptsLeft = job.proofPolicy.otpAttemptLimit - (otpAttempts || 0);

  if (job.deliveryMode === DELIVERY_MODE.HANDOFF_REQUIRED) {
    if (attemptsLeft > 0) {
      actions.push({
        key: 'OTP',
        grade: online ? GRADE.A : GRADE.B,
        label: online ? 'Enter the customer code' : 'Enter code (will sync later)',
        attemptsLeft,
      });
    }
    actions.push({ key: 'ESCALATE', grade: GRADE.D, label: 'Customer not responding' });
  }

  if (
    job.deliveryMode === DELIVERY_MODE.LEAVE_AT_DOOR ||
    job.deliveryMode === DELIVERY_MODE.LEAVE_WITH_CONCIERGE
  ) {
    if (meetsFloor(GRADE.C, job.proofPolicy.minGrade)) {
      actions.push({ key: 'PHOTO', grade: GRADE.C, label: 'Take proof photo' });
    } else {
      actions.push({
        key: 'OTP',
        grade: online ? GRADE.A : GRADE.B,
        label: 'This order needs a code from the customer',
        attemptsLeft,
      });
    }
  }

  return { inFence: true, actions, blocker: null };
}

/**
 * Build the evidence bundle that gets uploaded. On an offline (grade B)
 * completion the server re-verifies all of this on sync -- and a GPS trail
 * that never entered the geofence is caught every time.
 */
export function buildEvidence({ job, grade, position, trail, code, photoUri, reason }) {
  return {
    jobId: job.id,
    grade,
    completedAt: new Date().toISOString(),
    position,
    gpsTrail: (trail || []).slice(-60),
    codeEntered: code || null,
    photoUri: photoUri || null,
    escalationReason: reason || null,
    distanceFromDropoffM: Math.round(metresBetween(position, job.dropoff)),
    appVersion: '0.1.0',
  };
}
