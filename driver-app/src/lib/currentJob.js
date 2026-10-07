/**
 * Never stuck: what the app does with dispatch's answer to "what am I carrying?"
 *
 * The app asks GET /v1/driver/current every 10 seconds and on every screen
 * change. Whatever the office did -- cancelled, closed, reassigned or cleared
 * a job -- the answer says so, and this module turns it into one action:
 *
 *   none     nothing changed (or no signal: bad signal never ends a delivery)
 *   end      the whole run is over: say why in one sentence, go Home
 *   drop     part of a run is over: say which order, carry on with the rest
 *   restore  dispatch has a job the phone forgot (reinstall, cleared storage)
 *   signout  the office signed this driver out (401): go to sign-in
 *
 * Pure, so every recovery path is tested without a phone (__tests__).
 */
import { insideGeofence } from './proof.js';

export const PICKUP_RADIUS_M = 250;
export const DOOR_RADIUS_M = 150;

export const STEP = {
  TO_STORE: 'TO_STORE', AT_STORE: 'AT_STORE', TO_CUSTOMER: 'TO_CUSTOMER', AT_DOOR: 'AT_DOOR',
};

const ENDED = {
  CANCELLED: 'The office cancelled this order. No action needed.',
  CLOSED: 'The office closed this order. No action needed.',
  REASSIGNED: 'This order was given to another driver. No action needed.',
  CLEARED: 'The office took this order off you. No action needed.',
};

/** One plain sentence for the driver, or null for a normal finish. */
export function endedMessage(reason) {
  if (reason === 'DELIVERED') return null;
  return ENDED[reason] ?? ENDED.CLOSED;
}

function partMessage(reason, job) {
  const num = job?.orderNumber ?? job?.id ?? '';
  const what = {
    CANCELLED: `Order ${num} was cancelled by the office.`,
    REASSIGNED: `Order ${num} was given to another driver.`,
    CLEARED: `The office took order ${num} off you.`,
  }[reason] ?? `Order ${num} was closed by the office.`;
  return `${what} Carry on with the rest.`;
}

/** The stops RunScreen walks through: the server's list, or pickup and drop-off for a single order. */
export function effectiveStops({ stops, jobs }) {
  if (stops?.length) return stops;
  const j = jobs?.[0];
  if (!j) return [];
  return [
    { kind: 'PICKUP', name: j.pickup?.name ?? 'Collection point', jobIds: [j.id],
      lat: j.pickup?.latitude, lng: j.pickup?.longitude },
    { kind: 'DROPOFF', name: j.dropoff?.name ?? 'Delivery address', jobIds: [j.id],
      lat: j.dropoff?.latitude, lng: j.dropoff?.longitude },
  ];
}

/** Which of the four delivery steps the driver is on. */
export function stepOf({ stops, jobs, stopIndex, position }) {
  const stop = effectiveStops({ stops, jobs })[stopIndex];
  if (!stop) return null;
  const pickup = stop.kind === 'PICKUP';
  const here = position && insideGeofence(position, { latitude: stop.lat, longitude: stop.lng },
    pickup ? PICKUP_RADIUS_M : DOOR_RADIUS_M);
  if (pickup) return here ? STEP.AT_STORE : STEP.TO_STORE;
  return here ? STEP.AT_DOOR : STEP.TO_CUSTOMER;
}

/**
 * Take some orders out of a run and keep the driver's place in it.
 * Stops left with no orders disappear; the current stop moves only if one
 * before it went.
 */
export function dropJobs({ jobs, stops, stopIndex }, jobIds) {
  const gone = new Set(jobIds);
  const all = effectiveStops({ stops, jobs });
  const kept = [];
  let index = 0;
  all.forEach((s, i) => {
    const ids = (s.jobIds ?? []).filter((id) => !gone.has(id));
    if (!ids.length) return;
    if (i < stopIndex) index += 1;
    kept.push({ ...s, jobIds: ids });
  });
  const left = jobs.filter((j) => !gone.has(j.id));
  return {
    jobs: left,
    // A single order is drawn from the job itself; keep a real list for a run.
    stops: left.length > 1 ? kept : [],
    stopIndex: left.length > 1 ? Math.min(index, Math.max(0, kept.length - 1))
      : (kept.length === 2 ? Math.min(index, 1) : 0),
  };
}

/**
 * @param local   { jobs } as the app holds them (done drops have done: true)
 * @param result  { ok: true, body } from /current, or { ok: false, status }
 */
export function reconcile(local, result) {
  if (!result?.ok) return result?.status === 401 ? { action: 'signout' } : { action: 'none' };
  const body = result.body ?? {};
  const held = (local.jobs ?? []).filter((j) => !j.done);

  if (!held.length) {
    return body.jobs?.length
      ? { action: 'restore', jobs: body.jobs, stops: body.stops ?? [], stopIndex: body.stopIndex ?? 0,
          batchId: body.batchId ?? null, stage: body.stage ?? 'NAVIGATE_STORE' }
      : { action: 'none' };
  }

  const heldIds = new Set(held.map((j) => j.id));
  const ended = (body.ended ?? []).filter((e) => heldIds.has(e.jobId));
  if (!ended.length) return { action: 'none' };

  const office = ended.filter((e) => e.reason !== 'DELIVERED');
  const left = held.filter((j) => !ended.some((e) => e.jobId === j.id));
  if (!left.length) {
    const reason = office[0]?.reason ?? 'DELIVERED';
    return { action: 'end', reason, message: endedMessage(reason) };
  }
  const first = office[0];
  return {
    action: 'drop',
    jobIds: ended.map((e) => e.jobId),
    message: first ? partMessage(first.reason, held.find((j) => j.id === first.jobId)) : null,
  };
}
