/**
 * Driver supply state machine.
 *
 * A driver is in exactly one supply state at any moment. Dispatch reads this
 * to decide what it may offer, and the transitions are what stop a courier
 * disappearing out of a zone at 17:30 with a 40 km parcel.
 *
 *   OFFLINE ──▶ ZONE_COMMITTED ◀──▶ ROAMING_ELIGIBLE
 *                    ▲                     │
 *                    │                     ▼
 *                RETURNING ◀────────  ROAMING_ACTIVE
 *
 * RETURNING is the state most systems forget. A driver who dropped a parcel
 * two suburbs away is not lost supply -- they are supply that happens to be
 * over there, and anything heading back toward the zone should be offered to
 * them. Backhaul is what turns a one-way displacement into a round trip.
 */

export const S = {
  OFFLINE: 'OFFLINE',
  ZONE_COMMITTED: 'ZONE_COMMITTED',
  ROAMING_ELIGIBLE: 'ROAMING_ELIGIBLE',
  ROAMING_ACTIVE: 'ROAMING_ACTIVE',
  RETURNING: 'RETURNING',
};

export const LABELS = {
  [S.OFFLINE]: { title: 'Offline', sub: 'Not receiving offers' },
  [S.ZONE_COMMITTED]: { title: 'Online in zone', sub: 'Local deliveries only' },
  [S.ROAMING_ELIGIBLE]: { title: 'Online, roaming', sub: 'Long runs included' },
  [S.ROAMING_ACTIVE]: { title: 'On a long run', sub: 'Out of your zone' },
  [S.RETURNING]: { title: 'Heading back', sub: 'Backhaul jobs offered' },
};

const TRANSITIONS = {
  [S.OFFLINE]: [S.ZONE_COMMITTED],
  [S.ZONE_COMMITTED]: [S.OFFLINE, S.ROAMING_ELIGIBLE],
  [S.ROAMING_ELIGIBLE]: [S.OFFLINE, S.ZONE_COMMITTED, S.ROAMING_ACTIVE],
  [S.ROAMING_ACTIVE]: [S.RETURNING],
  [S.RETURNING]: [S.ZONE_COMMITTED, S.ROAMING_ACTIVE],
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/**
 * Guard rails. The driver may not simply toggle roaming whenever they like:
 * you cannot switch while holding a job, and you cannot go offline mid-run.
 */
export function transition(current, next, ctx = {}) {
  if (!canTransition(current, next)) {
    return { ok: false, reason: `Cannot go from ${current} to ${next}` };
  }
  if (ctx.activeJob && next === S.OFFLINE) {
    return { ok: false, reason: 'Finish your current delivery first' };
  }
  if (ctx.activeJob && next === S.ROAMING_ELIGIBLE) {
    return { ok: false, reason: 'You can switch to roaming once this delivery is done' };
  }
  return { ok: true, state: next };
}

/** What dispatch is allowed to send, given the state. */
export function acceptsJobKind(state, kind) {
  if (kind === 'ZONE') {
    return [S.ZONE_COMMITTED, S.ROAMING_ELIGIBLE, S.RETURNING].includes(state);
  }
  if (kind === 'ROAMING') return state === S.ROAMING_ELIGIBLE;
  if (kind === 'BACKHAUL') return state === S.RETURNING;
  return false;
}

/**
 * The roaming premium is set server-side from zone supply health:
 *
 *   supplyRatio = availableDrivers / (pendingJobs + forecastNext30min)
 *
 * High ratio at 14:00 means the zone is oversupplied, so the premium rises
 * until enough drivers opt across. At 17:30 it collapses to zero and roaming
 * drivers drift back to zone work on their own. This mirrors that locally so
 * the app can show something sensible while offline.
 */
export function estimateRoamingPremium(supplyRatio) {
  if (supplyRatio == null) return 0;
  if (supplyRatio < 1.0) return 0;        // zone is short, do not tempt anyone away
  if (supplyRatio < 1.4) return 0.1;
  if (supplyRatio < 2.0) return 0.25;
  return 0.4;
}
