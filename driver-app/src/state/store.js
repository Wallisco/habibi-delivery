import React, { createContext, useContext, useEffect, useReducer, useRef, useCallback } from 'react';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { S as SUPPLY, transition, estimateRoamingPremium, acceptsJobKind } from '../lib/supplyState';
import { createApi, makeDemoJob, DEMO } from '../lib/api';
import { enqueue, drain, isBlocked, readQueue } from '../lib/queue';
import { reconcile, dropJobs, effectiveStops } from '../lib/currentJob';
import { metresBetween } from '../lib/proof';
import * as ImagePicker from 'expo-image-picker';
import { enqueuePhoto, drainPhotos, readPhotos } from '../lib/photoQueue';

/** How often waiting collection photos are retried. */
export const PHOTO_RETRY_MS = 30000;

/** How often the app asks dispatch what it is carrying (spec: within 10 s). */
export const CURRENT_CHECK_MS = 10000;
/** Most orders on one run (dispatch-service/src/batching.js MAX_BATCH). */
export const MAX_RUN = 2;

/**
 * Can dispatch still add an order to this run? Only while the driver is on the
 * way to collect their only order (dispatch checks again: same pickup area,
 * ready within 5 minutes of the first order).
 */
export const canStackOnRun = (s) =>
  !!s.job && s.jobs.filter((j) => !j.done).length < MAX_RUN
  && s.stopIndex === 0 && (s.stage ?? 'NAVIGATE_STORE') === 'NAVIGATE_STORE';

/** Within this of the drop-off, a next job can be offered (dispatch: CHAIN_NEAR_DROPOFF_M). */
export const CHAIN_NEAR_M = 400;

/**
 * Could dispatch offer a next job now? While delivering the only order, within
 * 400 m of its drop-off. Dispatch checks again (the store must be within 2 km
 * of the drop-off, on a fresh position).
 */
export const canChainNext = (s) => {
  if (!s.job || !s.position || s.jobs.filter((j) => !j.done).length !== 1) return false;
  const stop = effectiveStops(s)[s.stopIndex];
  if (stop?.kind !== 'DROPOFF') return false;
  return metresBetween(s.position, { latitude: stop.lat, longitude: stop.lng }) <= CHAIN_NEAR_M;
};

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

const initial = {
  ready: false,
  token: null,
  driver: null,
  supply: SUPPLY.OFFLINE,
  position: null,
  trail: [],
  offer: null,
  job: null,
  jobs: [],
  batchId: null,
  stops: [],
  stopIndex: 0,
  scanned: 0,
  stage: null,          // NAVIGATE_STORE | SCAN | NAVIGATE_CUSTOMER | PROOF
  otpAttempts: 0,
  online: true,
  pendingSync: 0,
  supplyRatio: 1.6,
  zone: 'Durbanville',
  earnings: null,
  toast: null,
};

function reducer(s, a) {
  switch (a.type) {
    case 'READY': return { ...s, ready: true, ...a.payload };
    case 'SIGN_IN': return { ...s, token: a.token, driver: a.driver };
    case 'SIGN_OUT': return { ...initial, ready: true };
    case 'SUPPLY': return { ...s, supply: a.state };
    case 'POSITION': return { ...s, position: a.position, trail: [...s.trail, a.position].slice(-120) };
    case 'OFFER': return { ...s, offer: a.offer };
    case 'ACCEPT': {
      const jobs = a.jobs?.length ? a.jobs : (a.job ? [a.job] : []);
      return {
        ...s,
        offer: null,
        job: jobs[0] ?? null,
        jobs,
        batchId: a.batchId ?? null,
        stops: a.stops ?? [],
        stopIndex: a.stopIndex ?? 0,
        stage: a.stage ?? 'NAVIGATE_STORE',
        scanned: a.scanned ?? 0,
        otpAttempts: 0,
        supply: jobs.some((j) => j.kind === 'ROAMING') ? SUPPLY.ROAMING_ACTIVE : s.supply,
      };
    }
    case 'STOP': return { ...s, stopIndex: a.index, stage: a.stage ?? s.stage, otpAttempts: 0 };
    case 'JOB_DONE': {
      // Mark one drop complete without ending the run. The driver still has
      // food in the box for the remaining stops.
      const jobs = s.jobs.map((j) => (j.id === a.jobId ? { ...j, done: true } : j));
      return { ...s, jobs };
    }
    case 'DROP_JOBS': {
      // The office ended some orders on this run; carry on with the rest.
      const next = dropJobs(s, a.jobIds);
      return { ...s, ...next, job: next.jobs[0] ?? null, otpAttempts: 0 };
    }
    case 'STAGE': return { ...s, stage: a.stage };
    case 'SCANNED': return { ...s, scanned: a.count };
    case 'OTP_FAIL': return { ...s, otpAttempts: s.otpAttempts + 1 };
    case 'FINISH':
      return { ...s, job: null, jobs: [], batchId: null, stops: [], stopIndex: 0,
        stage: null, scanned: 0, otpAttempts: 0,
        supply: s.supply === SUPPLY.ROAMING_ACTIVE ? SUPPLY.RETURNING : s.supply };
    case 'CONNECTIVITY': return { ...s, online: a.online };
    case 'PENDING': return { ...s, pendingSync: a.count };
    case 'EARNINGS': return { ...s, earnings: a.earnings };
    case 'TOAST': return { ...s, toast: a.toast };
    default: return s;
  }
}


/**
 * The dispatch service speaks {lat,lng}; the app's geo helpers expect
 * {latitude,longitude}. One translation point rather than branching everywhere.
 */
function normaliseServerJob(j) {
  // A job created straight from the API may carry bare coordinates with no
  // label. The UI must never receive an undefined name -- it renders them.
  const pt = (p, fallback) => (p
    ? {
        ...p,
        name: p.name ?? fallback,
        latitude: p.latitude ?? p.lat,
        longitude: p.longitude ?? p.lng,
      }
    : { name: fallback, latitude: 0, longitude: 0 });

  return {
    ...j,
    pickup: pt(j.pickup, j.storeId ?? 'Collection point'),
    dropoff: pt(j.dropoff, 'Delivery address'),
    orderNumber: j.orderNumber ?? null,
    ageRestricted: j.ageRestricted ?? false,
    distanceKm: j.distanceKm ?? 0,
    distanceSource: j.distanceSource ?? 'estimated',
    tip: Number(j.tip ?? 0),
    earningsPreview: j.earningsPreview ?? null,
    fee: j.fee ?? 35,
    estimatedTip: j.estimatedTip ?? 0,
    bagCount: j.bagCount ?? 1,
    readyInMinutes: j.readyInMinutes ?? 0,
    proofPolicy: j.proofPolicy ?? {
      minGrade: 'C', geofenceMetres: 150, otpAttemptLimit: 4,
    },
  };
}

/**
 * @param onJobEnded  called when the office ended the whole run, after the
 *                    message is set: the app goes Home (App.js).
 */
export function AppProvider({ children, onJobEnded }) {
  const [state, dispatch] = useReducer(reducer, initial);
  // Any 401 from dispatch signs the driver out (see signOut below).
  const unauthorized = useRef(() => {});
  const makeApi = (token, driverId) =>
    createApi(token, driverId, { onUnauthorized: () => unauthorized.current() });
  const api = useRef(makeApi(null));
  const watcher = useRef(null);
  const offerTimer = useRef(null);
  // The latest state, for timers and callbacks that outlive a render.
  const latest = useRef(state);
  latest.current = state;
  const jobEnded = useRef(onJobEnded);
  jobEnded.current = onJobEnded;

  const ACTIVE_KEY = 'active_delivery_v1';

  // ---------------------------------------------------------------- boot
  useEffect(() => {
    (async () => {
      let token = null, driver = null;
      try {
        token = await SecureStore.getItemAsync('token');
        const raw = await SecureStore.getItemAsync('driver');
        driver = raw ? JSON.parse(raw) : null;
      } catch { /* first run */ }
      api.current = makeApi(token, driver?.id);
      const q = await readQueue(driver?.id);

      // Restore an in-flight delivery. Without this, backgrounding the app or
      // a Metro reload leaves a driver holding food with no destination.
      let payload = { token, driver, pendingSync: q.length };
      try {
        const saved = await AsyncStorage.getItem(ACTIVE_KEY);
        if (saved) {
          const r = JSON.parse(saved);
          if (r.jobs?.length) {
            payload = { ...payload, jobs: r.jobs, job: r.jobs[0], batchId: r.batchId,
              stops: r.stops ?? [], stopIndex: r.stopIndex ?? 0,
              stage: r.stage, scanned: r.scanned, supply: SUPPLY.ZONE_COMMITTED };
          }
        }
      } catch { /* nothing saved */ }

      dispatch({ type: 'READY', payload });
    })();
  }, []);

  // Write through on every change to the active delivery.
  useEffect(() => {
    if (!state.ready) return;
    if (state.job) {
      AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify({
        jobs: state.jobs, batchId: state.batchId, stops: state.stops,
        stopIndex: state.stopIndex, stage: state.stage, scanned: state.scanned,
      })).catch(() => {});
    } else {
      AsyncStorage.removeItem(ACTIVE_KEY).catch(() => {});
    }
  }, [state.job, state.jobs, state.stops, state.stopIndex, state.stage, state.scanned, state.ready]);

  // ------------------------------------------------------------ location
  const startLocation = useCallback(async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      dispatch({ type: 'TOAST', toast: 'Location permission is required to receive jobs.' });
      return false;
    }
    watcher.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, distanceInterval: 15, timeInterval: 5000 },
      (loc) => dispatch({
        type: 'POSITION',
        position: {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          at: Date.now(),
        },
      })
    );
    return true;
  }, []);

  // The server can only dispatch to a driver whose position it knows. Pushed
  // on a throttle rather than every fix -- at scale this is ~500 writes/sec
  // across the fleet and it is the dominant write load in the whole system.
  const lastPush = useRef(0);
  useEffect(() => {
    if (DEMO || !state.position || !state.driver) return;
    // Faster while a customer is watching the map, slower when idle. The
    // difference matters: a marker that jumps every eight seconds reads as
    // broken, and battery matters more than freshness when nobody is looking.
    const interval = state.job ? 4000 : 12000;
    if (Date.now() - lastPush.current < interval) return;
    lastPush.current = Date.now();
    api.current.pushPosition?.(state.position.latitude, state.position.longitude)
      .catch(() => dispatch({ type: 'CONNECTIVITY', online: false }));
  }, [state.position, state.driver, state.job]);

  const stopLocation = useCallback(() => {
    watcher.current?.remove?.();
    watcher.current = null;
  }, []);

  useEffect(() => () => stopLocation(), [stopLocation]);

  // --------------------------------------------------------- supply state
  const setSupply = useCallback(async (next) => {
    const res = transition(state.supply, next, { activeJob: !!state.job });
    if (!res.ok) {
      dispatch({ type: 'TOAST', toast: res.reason });
      return;
    }
    if (next === SUPPLY.OFFLINE) stopLocation();
    if (state.supply === SUPPLY.OFFLINE) {
      const ok = await startLocation();
      if (!ok) return;
    }
    if (!DEMO) {
      try {
        await api.current.setState(next, state.zone);
      } catch (e) {
        dispatch({ type: 'TOAST', toast: e.message ?? 'Could not reach dispatch.' });
        // An account problem is not transient -- refresh the checklist so the
        // driver sees what is actually outstanding rather than retrying.
        fetchAccountNow();
        return;
      }
    }
    dispatch({ type: 'SUPPLY', state: next });
  }, [state.supply, state.job, startLocation, stopLocation]);

  // After a restart, come back online if dispatch still has us online. What
  // we are carrying is the current-job check's business (below).
  const reconciled = useRef(false);
  useEffect(() => {
    if (DEMO || !state.ready || !state.driver || reconciled.current) return;
    reconciled.current = true;
    (async () => {
      try {
        const shift = await api.current.fetchShift();
        if (shift.state && shift.state !== SUPPLY.OFFLINE) {
          dispatch({ type: 'SUPPLY', state: shift.state });
          startLocation();
        }
      } catch { /* offline; local state stands */ }
    })();
  }, [state.ready, state.driver, startLocation]);

  // ------------------------------------------------------- never stuck
  // Ask dispatch what we are carrying, every 10 seconds and on every screen
  // change (App.js). The server wins: if the office cancelled, closed,
  // reassigned or cleared a job, the driver is told in one sentence and goes
  // Home; if the office signed them out, they go to sign-in. No signal changes
  // nothing -- a driver in a dead spot keeps their delivery.
  const checking = useRef(false);
  const checkNow = useCallback(async () => {
    const s = latest.current;
    if (DEMO || checking.current || !s.ready || !s.token || !api.current.current) return;
    checking.current = true;
    let result;
    try {
      result = { ok: true, body: await api.current.current(s.jobs.filter((j) => !j.done).map((j) => j.id)) };
      dispatch({ type: 'CONNECTIVITY', online: true });
    } catch (e) {
      result = { ok: false, status: e.status ?? 0 };
    } finally {
      checking.current = false;
    }
    const now = latest.current;
    if (now.token !== s.token) return;   // signed out meanwhile
    const r = reconcile(now, result);
    if (r.action === 'signout') {
      unauthorized.current();
    } else if (r.action === 'end') {
      dispatch({ type: 'FINISH' });
      if (r.message) dispatch({ type: 'TOAST', toast: r.message });
      jobEnded.current?.(r);
    } else if (r.action === 'drop') {
      dispatch({ type: 'DROP_JOBS', jobIds: r.jobIds });
      if (r.message) dispatch({ type: 'TOAST', toast: r.message });
    } else if (r.action === 'restore') {
      dispatch({ type: 'ACCEPT', jobs: r.jobs.map(normaliseServerJob), batchId: r.batchId,
        stops: r.stops, stopIndex: r.stopIndex, stage: r.stage });
      dispatch({ type: 'TOAST', toast: 'Picked up your delivery where you left off.' });
    }
  }, []);

  useEffect(() => {
    if (DEMO || !state.ready || !state.token) return;
    checkNow();
    const t = setInterval(checkNow, CURRENT_CHECK_MS);
    return () => clearInterval(t);
  }, [state.ready, state.token, checkNow]);

  // ----------------------------------------------- collection photos
  // Uploaded in the background; a dead spot only delays them.
  const uploading = useRef(false);
  const uploadPhotos = useCallback(async () => {
    const s = latest.current;
    if (DEMO || uploading.current || !s.token || !s.driver) return;
    uploading.current = true;
    try {
      const res = await drainPhotos(api.current, s.driver.id);
      if (res.unauthorized) unauthorized.current();
    } finally {
      uploading.current = false;
    }
  }, []);

  useEffect(() => {
    if (DEMO || !state.ready || !state.token) return;
    uploadPhotos();
    const t = setInterval(async () => {
      if ((await readPhotos(latest.current.driver?.id)).length) uploadPhotos();
    }, PHOTO_RETRY_MS);
    return () => clearInterval(t);
  }, [state.ready, state.token, uploadPhotos]);

  /**
   * Take the photo of the order at the store. Returns the photo's local uri,
   * or null if the driver backed out or refused the camera. It is queued at
   * once and uploaded when there is signal.
   */
  const takeCollectionPhoto = async (jobIds) => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (perm.status !== 'granted') {
      dispatch({ type: 'TOAST', toast: 'Allow the camera to take the collection photo.' });
      return null;
    }
    const shot = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.4, exif: false });
    const uri = shot.canceled ? null : shot.assets?.[0]?.uri;
    if (!uri) return null;
    await enqueuePhoto({ uri, jobIds, driverId: latest.current.driver?.id ?? null });
    uploadPhotos();
    return uri;
  };

  // Real mode: poll the dispatcher for an offer. Production would use FCM/APNs
  // so an offer wakes the device; polling keeps the app honest without push
  // infrastructure and is fine at this stage.
  // While carrying a job, keep looking only if a second order could still join
  // the run (on-the-run stacking) or a next job could be offered near the
  // drop-off.
  const stackable = canStackOnRun(state) || canChainNext(state);
  useEffect(() => {
    if (DEMO || !state.driver) return;
    const canReceive = [SUPPLY.ZONE_COMMITTED, SUPPLY.ROAMING_ELIGIBLE, SUPPLY.RETURNING]
      .includes(state.supply);
    if (!canReceive || (state.job && !stackable)) return;

    const poll = setInterval(async () => {
      try {
        const shift = await api.current.fetchShift();
        dispatch({ type: 'CONNECTIVITY', online: true });
        if (shift.offer && !state.offer) {
          const o = shift.offer;
          dispatch({ type: 'OFFER', offer: {
            ...normaliseServerJob(o.job),
            batchId: o.batchId ?? null,
            jobs: (o.jobs ?? [o.job]).map(normaliseServerJob),
            stops: o.stops ?? [],
            summary: o.summary ?? null,
            addsToRun: Boolean(o.addsToRun),
            chained: Boolean(o.chained),
            storeFromDropoffKm: o.storeFromDropoffKm ?? null,
          } });
        }
      } catch {
        dispatch({ type: 'CONNECTIVITY', online: false });
      }
    }, 3000);
    return () => clearInterval(poll);
  }, [state.supply, state.job, state.offer, state.driver, stackable]);

  useEffect(() => {
    if (!DEMO) return;
    const canReceive = [SUPPLY.ZONE_COMMITTED, SUPPLY.ROAMING_ELIGIBLE, SUPPLY.RETURNING]
      .includes(state.supply);
    if (!canReceive || state.job || state.offer) return;

    offerTimer.current = setTimeout(async () => {
      const blocked = await isBlocked(state.driver?.id);
      if (blocked.blocked) {
        dispatch({ type: 'TOAST', toast: blocked.reason });
        return;
      }
      const kind = state.supply === SUPPLY.ROAMING_ELIGIBLE && Math.random() < 0.35
        ? 'ROAMING' : 'ZONE';
      if (!acceptsJobKind(state.supply, kind)) return;
      dispatch({ type: 'OFFER', offer: makeDemoJob(kind) });
    }, 4000 + Math.random() * 6000);

    return () => clearTimeout(offerTimer.current);
  }, [state.supply, state.job, state.offer]);

  // ------------------------------------------------------------- actions
  const signIn = async (phone) => {
    const res = await api.current.signIn(phone);
    api.current = makeApi(res.token, res.driver.id);
    try {
      await SecureStore.setItemAsync('token', res.token);
      await SecureStore.setItemAsync('driver', JSON.stringify(res.driver));
    } catch { /* non-fatal */ }
    dispatch({ type: 'SIGN_IN', token: res.token, driver: res.driver });
  };

  // Also what a 401 does: the office signed this driver out. Queued offline
  // completions stay on the phone for when they sign in again.
  const signOut = async () => {
    stopLocation();
    api.current = makeApi(null);
    reconciled.current = false;
    dispatch({ type: 'SIGN_OUT' });
    try {
      await SecureStore.deleteItemAsync('token');
      await SecureStore.deleteItemAsync('driver');
    } catch { /* ignore */ }
  };
  unauthorized.current = signOut;

  const acceptOffer = async () => {
    if (!state.offer) return;
    if (!DEMO) {
      const addsToRun = !!state.job;
      try {
        // On the run, dispatch answers with the whole run: replace what we hold.
        const res = await api.current.acceptJob(state.offer.id);
        // Dispatch says where the driver is in the run, so a next job taken
        // at the door keeps them on the current drop-off.
        dispatch({
          type: 'ACCEPT',
          jobs: (res.jobs ?? [res.job]).map(normaliseServerJob),
          batchId: res.batchId ?? null,
          stops: res.stops ?? [],
          stopIndex: res.stopIndex ?? 0,
          stage: res.stage ?? 'NAVIGATE_STORE',
        });
        if (res.chained) dispatch({ type: 'TOAST', toast: 'Next job added. Finish this drop-off first.' });
        else if (addsToRun) dispatch({ type: 'TOAST', toast: 'Second order added to your run.' });
        return;
      } catch (e) {
        dispatch({ type: 'OFFER', offer: null });
        // Dispatch's own reason ("Offer expired", "Offer no longer valid"),
        // not a guess. Only a failure to reach dispatch gets a generic line.
        dispatch({ type: 'TOAST', toast: e.status === 409 && e.message
          ? `${e.message}.`.replace(/\.\.$/, '.')
          : 'Could not reach dispatch. The offer was not accepted.' });
        return;
      }
    }
    dispatch({ type: 'ACCEPT', job: state.offer });
  };

  const declineOffer = () => {
    if (!DEMO && state.offer) api.current.declineJob(state.offer.id).catch(() => {});
    dispatch({ type: 'OFFER', offer: null });
  };

  // Ran out of time. Not a decline: dispatch expires it and offers it to
  // someone else, and this driver can see it again sooner.
  const expireOffer = () => {
    if (!latest.current.offer) return;
    dispatch({ type: 'OFFER', offer: null });
    dispatch({ type: 'TOAST', toast: 'Offer expired.' });
  };

  const completeJob = async (evidence) => {
    const driverId = state.driver?.id ?? null;
    if (state.online) {
      try {
        await api.current.postCompletion(evidence);
      } catch (e) {
        // Refused for good (cancelled or closed meanwhile): nothing to keep.
        // Anything else -- no signal, a 5xx, signed out -- is kept and synced later.
        if (![404, 409, 410, 422].includes(e.status)) await enqueue(evidence, driverId);
      }
    } else {
      await enqueue(evidence, driverId);
    }
    const q = await readQueue(driverId);
    dispatch({ type: 'PENDING', count: q.length });
    // Only the last drop ends the run; the rest of the box is still to go.
    const others = latest.current.jobs.filter((j) => !j.done && j.id !== evidence.jobId);
    dispatch(others.length ? { type: 'JOB_DONE', jobId: evidence.jobId } : { type: 'FINISH' });
  };

  const syncNow = async () => {
    const res = await drain(api.current, state.driver?.id);
    if (res.unauthorized) { signOut(); return; }
    dispatch({ type: 'PENDING', count: res.remaining });
    dispatch({
      type: 'TOAST',
      toast: res.synced ? `${res.synced} delivery${res.synced > 1 ? 'ies' : ''} synced` : 'Nothing to sync',
    });
  };

  const loadEarnings = async () => {
    try {
      dispatch({ type: 'EARNINGS', earnings: await api.current.fetchEarnings() });
    } catch {
      dispatch({ type: 'TOAST', toast: 'Could not load earnings. Showing last known.' });
    }
  };

  const fetchAccountNow = useCallback(() => {
    api.current.fetchAccount?.().then((a) => {
      if (a && a.canWork === false) {
        dispatch({ type: 'TOAST',
          toast: a.outstanding?.length
            ? `Your account is not active yet. Outstanding: ${a.outstanding.join(', ')}.`
            : 'Your account is awaiting approval from the office.' });
      }
    }).catch(() => {});
  }, []);

  const value = {
    ...state,
    api: api.current,
    roamingPremium: estimateRoamingPremium(state.supplyRatio),
    setSupply, signIn, signOut, acceptOffer, declineOffer, expireOffer,
    completeJob, syncNow, loadEarnings, checkNow, takeCollectionPhoto,
    setStage: (stage) => dispatch({ type: 'STAGE', stage }),
    setScanned: (count) => dispatch({ type: 'SCANNED', count }),
    goToStop: (index, stage) => dispatch({ type: 'STOP', index, stage }),
    markJobDone: (jobId) => dispatch({ type: 'JOB_DONE', jobId }),
    fetchJobs: () => api.current.fetchJobs?.() ?? Promise.resolve({ active: [], completed: [] }),
    fetchAccount: () => api.current.fetchAccount?.() ?? Promise.resolve(null),
    fetchMessages: () => api.current.fetchMessages?.() ?? Promise.resolve({ messages: [], unread: 0 }),
    sendMessage: (body, jobId) => api.current.sendMessage?.(body, jobId),
    markMessagesRead: () => api.current.markMessagesRead?.(),
    noteOtpFail: () => dispatch({ type: 'OTP_FAIL' }),
    toastMsg: (toast) => dispatch({ type: 'TOAST', toast }),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
