/**
 * API client.
 *
 * demoMode (app.json -> extra.demoMode) runs a local mock dispatch so the app
 * is demonstrable before the dispatch service exists. Set it false and point
 * apiBaseUrl at the real service; nothing else in the app changes.
 */

import Constants from 'expo-constants';
import { DELIVERY_MODE, GRADE } from './proof';

const extra = Constants.expoConfig?.extra ?? {};
const BASE = extra.apiBaseUrl;
export const DEMO = extra.demoMode !== false;

const TIMEOUT_MS = 8000;

/**
 * Every call is time-boxed. Without this a driver on a bad connection sees a
 * spinner forever instead of an error they can act on -- and on a delivery
 * app, "nothing is happening" is the worst possible failure mode.
 *
 * Errors carry `status`: the HTTP status, or 0 when dispatch could not be
 * reached. Recovery depends on telling them apart -- a 401 means signed out,
 * a 0 means bad signal and must never end a delivery.
 */
const failure = (message, status) => Object.assign(new Error(message), { status });

async function req(path, { timeoutMs = TIMEOUT_MS, ...options } = {}, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      // Surface the server's own reason. A 403 from /state means the account
      // is not activated yet, and telling a driver to "check their signal"
      // sends them hunting for a network problem that does not exist.
      let detail = null;
      try {
        const body = await res.json();
        detail = body.error ?? null;
        if (body.outstanding?.length) {
          detail += ` (${body.outstanding.join(', ')} not verified)`;
        }
      } catch { /* not JSON */ }
      throw failure(detail ?? `Server returned ${res.status}`, res.status);
    }
    return await res.json();
  } catch (e) {
    if (e.status) throw e;
    if (e.name === 'AbortError') {
      throw failure(`Could not reach dispatch at ${BASE}. Check the server is running and that your phone is on the same network.`, 0);
    }
    throw failure(`${e.message} (${BASE})`, 0);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ demo data */

const STORES = [
  { name: "Roman's Pizza Durbanville", lat: -33.8312, lng: 18.6512, wait: 16.5 },
  { name: 'RocoMamas Durbanville', lat: -33.8288, lng: 18.6467, wait: 5.1 },
  { name: 'KFC Durbanville Drive-Thru', lat: -33.8341, lng: 18.6538, wait: 1.8 },
  { name: "Col'Cacchio Durbanville", lat: -33.8265, lng: 18.6491, wait: 29.7 },
  { name: 'Simply Asia Durbanville', lat: -33.8302, lng: 18.6455, wait: 15.6 },
];

const SUBURBS = ['Durbanville', 'Kenridge', 'Eversdal', 'Sonstraal', 'Vygeboom'];

let seq = 1000;

function jitter(base, spread) {
  return base + (Math.random() - 0.5) * spread;
}

export function makeDemoJob(kind = 'ZONE') {
  const store = STORES[Math.floor(Math.random() * STORES.length)];
  const roaming = kind === 'ROAMING';
  const spread = roaming ? 0.28 : 0.045;
  const items = 1 + Math.floor(Math.random() * 3);
  const distanceKm = roaming ? 12 + Math.random() * 28 : 1.5 + Math.random() * 5;
  const fee = roaming ? Math.round(35 + distanceKm * 2.1) : 35;

  // Leave-at-door is decided by the customer at checkout, never by the driver.
  const mode =
    Math.random() < 0.25 ? DELIVERY_MODE.LEAVE_AT_DOOR : DELIVERY_MODE.HANDOFF_REQUIRED;
  const ageRestricted = Math.random() < 0.08;

  return {
    id: `JOB-${seq++}`,
    kind,
    createdAt: Date.now(),
    pickup: { name: store.name, latitude: store.lat, longitude: store.lng },
    dropoff: {
      name: `${Math.floor(Math.random() * 80) + 1} ${
        ['Wellington', 'Oxford', 'Kloof', 'Church', 'Main'][Math.floor(Math.random() * 5)]
      } St, ${SUBURBS[Math.floor(Math.random() * SUBURBS.length)]}`,
      latitude: jitter(store.lat, spread),
      longitude: jitter(store.lng, spread),
    },
    itemCount: items,
    bagCount: items > 2 ? 2 : 1,
    distanceKm: Number(distanceKm.toFixed(1)),
    fee,
    estimatedTip: Math.random() < 0.7 ? Math.round(8 + Math.random() * 25) : 0,
    // The ready gate: the offer is released so the driver arrives as the food
    // is up, not twelve minutes early.
    readyInMinutes: Math.max(0, Math.round(store.wait * 0.3)),
    deliveryMode: ageRestricted ? DELIVERY_MODE.HANDOFF_REQUIRED : mode,
    ageRestricted,
    proofPolicy: {
      minGrade: ageRestricted ? GRADE.B : GRADE.C,
      geofenceMetres: 150,
      otpAttemptLimit: 4,
      doorstepTimerSeconds: 300,
    },
  };
}

/* ---------------------------------------------------------------- public API */

/**
 * @param onUnauthorized  called when dispatch answers 401 to a signed-in call:
 *                        the token was revoked (office sign-out) or expired.
 */
export function createApi(token, driverId, { onUnauthorized } = {}) {
  if (DEMO) {
    return {
      demo: true,
      async signIn(phone) {
        await new Promise((r) => setTimeout(r, 500));
        return { token: 'demo-token', driver: { id: 'DRV-7303', name: 'Driver', phone } };
      },
      async fetchShift() {
        return { supplyRatio: 1.6, zone: 'Durbanville', roamingPremiumActive: true };
      },
      async postCompletion() {
        await new Promise((r) => setTimeout(r, 400));
        return { accepted: true };
      },
      async verifyOtp(jobId, code) {
        await new Promise((r) => setTimeout(r, 350));
        // Demo: any 4-digit code ending in an even number is accepted.
        const ok = /^\d{4}$/.test(code) && Number(code[3]) % 2 === 0;
        return { verified: ok };
      },
      async fetchEarnings() {
        return {
          today: { orders: 7, delivery: 245, tips: 118 },
          week: { orders: 41, delivery: 1435, tips: 702, vehicleFee: 900 },
        };
      },
    };
  }

  // A signed-in call. Any 401 means this driver is signed out, whatever the
  // call was; the store answers by going to sign-in.
  const call = (path, options = {}) => req(path, options, token).catch((e) => {
    if (e.status === 401 && token) onUnauthorized?.();
    throw e;
  });

  // Endpoints match dispatch-service/src/server.js exactly.
  return {
    demo: false,
    signIn: (phone) =>
      req('/v1/driver/signin', { method: 'POST', body: JSON.stringify({ phone }) }),
    // What this driver is carrying, and what happened to the jobs the phone holds.
    current: (jobIds = []) =>
      call(`/v1/driver/current${jobIds.length ? `?jobs=${encodeURIComponent(jobIds.join(','))}` : ''}`),
    setState: (state, zone) =>
      call(`/v1/driver/${driverId}/state`, { method: 'POST', body: JSON.stringify({ state, zone }) }),
    pushPosition: (lat, lng) =>
      call(`/v1/driver/${driverId}/position`, { method: 'POST', body: JSON.stringify({ lat, lng }) }),
    fetchShift: () => call(`/v1/driver/${driverId}/shift`),
    acceptJob: (jobId) =>
      call(`/v1/jobs/${jobId}/accept`, { method: 'POST', body: JSON.stringify({ driverId }) }),
    declineJob: (jobId) =>
      call(`/v1/jobs/${jobId}/decline`, { method: 'POST', body: JSON.stringify({ driverId }) }),
    collect: (jobId) => call(`/v1/jobs/${jobId}/collect`, { method: 'POST' }),
    // Tells the server to issue the customer's code. The response deliberately
    // never contains it.
    approach: (jobId) => call(`/v1/jobs/${jobId}/approach`, { method: 'POST' }),
    verifyOtp: (jobId, code, position) =>
      call(`/v1/jobs/${jobId}/verify`, { method: 'POST', body: JSON.stringify({ code, position }) }),
    postCompletion: (evidence) =>
      call('/v1/jobs/complete', { method: 'POST', body: JSON.stringify(evidence) }),
    fetchEarnings: () => call(`/v1/driver/${driverId}/earnings`),
    fetchJobs: () => call(`/v1/driver/${driverId}/jobs`),
    fetchAccount: () => call(`/v1/driver/${driverId}/account`),
    fetchMessages: () => call(`/v1/driver/${driverId}/messages`),
    sendMessage: (body, jobId) => call(`/v1/driver/${driverId}/messages`,
      { method: 'POST', body: JSON.stringify({ body, jobId }) }),
    markMessagesRead: () => call(`/v1/driver/${driverId}/messages/read`, { method: 'POST' }),
    // Did the photo match the order? (stores in the photo-check trial)
    photoCheck: (jobIds) =>
      call(`/v1/driver/photo-check?jobs=${encodeURIComponent(jobIds.join(','))}`),
    // The photo of the order at collection: raw JPEG from the camera's file.
    // A slow connection gets longer than the usual 8 s.
    uploadCollectionPhoto: async (uri, jobIds) => {
      const blob = await (await fetch(uri)).blob();
      return call(`/v1/driver/collection-photo?jobs=${encodeURIComponent(jobIds.join(','))}`,
        { method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg' }, timeoutMs: 30000 });
    },
  };
}
