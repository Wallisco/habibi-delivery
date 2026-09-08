import React, { createContext, useContext, useEffect, useReducer, useRef, useCallback } from 'react';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { S as SUPPLY, transition, estimateRoamingPremium, acceptsJobKind } from '../lib/supplyState';
import { createApi, makeDemoJob, DEMO } from '../lib/api';
import { enqueue, drain, isBlocked, readQueue } from '../lib/queue';

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

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const api = useRef(createApi(null));
  const watcher = useRef(null);
  const offerTimer = useRef(null);

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
      api.current = createApi(token, driver?.id);
      const q = await readQueue();

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
  }, [state.job, state.stage, state.scanned, state.ready]);

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

  // ------------------------------------------------- demo offer generator
  // The server knows what this driver is carrying. If local state and the
  // server disagree, the server wins -- it survived the restart, we may not
  // have.
  const reconciled = useRef(false);
  useEffect(() => {
    if (DEMO || !state.ready || !state.driver || reconciled.current) return;
    reconciled.current = true;
    (async () => {
      try {
        const shift = await api.current.fetchShift();
        if (shift.activeJob && !state.job) {
          dispatch({
            type: 'ACCEPT',
            jobs: (shift.activeJobs?.length ? shift.activeJobs : [shift.activeJob])
              .map(normaliseServerJob),
            batchId: shift.activeBatchId ?? null,
            stops: shift.activeStops ?? [],
            stage: shift.activeStage ?? 'NAVIGATE_STORE',
          });
          dispatch({ type: 'TOAST', toast: 'Picked up your delivery where you left off.' });
        }
        if (shift.state && shift.state !== SUPPLY.OFFLINE) {
          dispatch({ type: 'SUPPLY', state: shift.state });
          startLocation();
        }
      } catch { /* offline; local state stands */ }
    })();
  }, [state.ready, state.driver, state.job, startLocation]);

  // Real mode: poll the dispatcher for an offer. Production would use FCM/APNs
  // so an offer wakes the device; polling keeps the app honest without push
  // infrastructure and is fine at this stage.
  useEffect(() => {
    if (DEMO || !state.driver) return;
    const canReceive = [SUPPLY.ZONE_COMMITTED, SUPPLY.ROAMING_ELIGIBLE, SUPPLY.RETURNING]
      .includes(state.supply);
    if (!canReceive || state.job) return;

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
          } });
        }
      } catch {
        dispatch({ type: 'CONNECTIVITY', online: false });
      }
    }, 3000);
    return () => clearInterval(poll);
  }, [state.supply, state.job, state.offer, state.driver]);

  useEffect(() => {
    if (!DEMO) return;
    const canReceive = [SUPPLY.ZONE_COMMITTED, SUPPLY.ROAMING_ELIGIBLE, SUPPLY.RETURNING]
      .includes(state.supply);
    if (!canReceive || state.job || state.offer) return;

    offerTimer.current = setTimeout(async () => {
      const blocked = await isBlocked();
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
    api.current = createApi(res.token, res.driver.id);
    try {
      await SecureStore.setItemAsync('token', res.token);
      await SecureStore.setItemAsync('driver', JSON.stringify(res.driver));
    } catch { /* non-fatal */ }
    dispatch({ type: 'SIGN_IN', token: res.token, driver: res.driver });
  };

  const signOut = async () => {
    stopLocation();
    try {
      await SecureStore.deleteItemAsync('token');
      await SecureStore.deleteItemAsync('driver');
    } catch { /* ignore */ }
    dispatch({ type: 'SIGN_OUT' });
  };

  const acceptOffer = async () => {
    if (!state.offer) return;
    if (!DEMO) {
      try {
        const res = await api.current.acceptJob(state.offer.id);
        dispatch({
          type: 'ACCEPT',
          jobs: (res.jobs ?? [res.job]).map(normaliseServerJob),
          batchId: res.batchId ?? null,
          stops: res.stops ?? [],
        });
        return;
      } catch {
        dispatch({ type: 'OFFER', offer: null });
        dispatch({ type: 'TOAST', toast: 'That job went to someone else.' });
        return;
      }
    }
    dispatch({ type: 'ACCEPT', job: state.offer });
  };

  const declineOffer = () => {
    if (!DEMO && state.offer) api.current.declineJob(state.offer.id).catch(() => {});
    dispatch({ type: 'OFFER', offer: null });
  };

  const completeJob = async (evidence) => {
    if (state.online) {
      try {
        await api.current.postCompletion(evidence);
      } catch {
        await enqueue(evidence);
      }
    } else {
      await enqueue(evidence);
    }
    const q = await readQueue();
    dispatch({ type: 'PENDING', count: q.length });
    dispatch({ type: 'FINISH' });
  };

  const syncNow = async () => {
    const res = await drain(api.current);
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
    setSupply, signIn, signOut, acceptOffer, declineOffer,
    completeJob, syncNow, loadEarnings,
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
