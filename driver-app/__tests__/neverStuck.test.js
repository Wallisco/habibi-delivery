// Never stuck, end to end inside the app: the real store (AppProvider) with a
// fake dispatch. Whatever the office does, the phone recovers within 10 s.
import React from 'react';
import { act, create } from 'react-test-renderer';
import { AppProvider, useApp, CURRENT_CHECK_MS } from '../src/state/store';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const mockSecure = new Map();
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k) => mockSecure.get(k) ?? null,
  setItemAsync: async (k, v) => { mockSecure.set(k, v); },
  deleteItemAsync: async (k) => { mockSecure.delete(k); },
}));

jest.mock('expo-location', () => ({
  Accuracy: { High: 4 },
  requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
  watchPositionAsync: async () => ({ remove() {} }),
}));

// Dispatch, as the app's API client sees it. `mockServer.current` answers
// GET /v1/driver/current: { status, body }.
const mockServer = { current: () => ({ status: 200, body: { jobs: [], ended: [] } }), completions: [] };
jest.mock('../src/lib/api', () => ({
  DEMO: false,
  makeDemoJob: () => null,
  createApi: (token, driverId, opts = {}) => ({
    async current(ids) {
      const r = mockServer.current(token, ids);
      if (r.status !== 200) {
        if (r.status === 401 && token) opts.onUnauthorized?.();
        throw Object.assign(new Error(`status ${r.status}`), { status: r.status });
      }
      return r.body;
    },
    fetchShift: async () => ({ state: 'OFFLINE' }),
    postCompletion: async (e) => { mockServer.completions.push(e); return { accepted: true }; },
  }),
}));

const AsyncStorage = require('@react-native-async-storage/async-storage');

const STORE = { latitude: -33.8312, longitude: 18.6512, name: 'KFC Milnerton' };
const DOOR = { latitude: -33.8401, longitude: 18.6588, name: '14 Pienaar Road' };
const job = (id) => ({ id, orderNumber: `KFC-${id}`, pickup: STORE, dropoff: DOOR, bagCount: 1 });

let app;
function Probe() { app = useApp(); return null; }

/** A signed-in driver whose phone is part-way through a delivery. */
async function start({ jobs = [job('J1')], stops = [], stopIndex = 0, stage = 'NAVIGATE_STORE' } = {}) {
  mockSecure.set('token', 'dt_test');
  mockSecure.set('driver', JSON.stringify({ id: 'D1' }));
  await AsyncStorage.setItem('active_delivery_v1', JSON.stringify({ jobs, stops, stopIndex, stage, scanned: 0 }));
  const onJobEnded = jest.fn();
  let r;
  await act(async () => { r = create(<AppProvider onJobEnded={onJobEnded}><Probe /></AppProvider>); });
  await flush();
  return { r, onJobEnded };
}
const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => {}); };
const tick = async (ms = CURRENT_CHECK_MS) => { await act(async () => { jest.advanceTimersByTime(ms); }); await flush(); };

const carrying = (...ids) => () => ({ status: 200, body: { jobs: ids.map(job), ended: [] } });
const ended = (jobId, reason) => () => ({ status: 200, body: { jobs: [], ended: [{ jobId, reason }] } });

beforeEach(async () => {
  jest.useFakeTimers();
  mockSecure.clear();
  await AsyncStorage.clear();
  mockServer.current = carrying('J1');
  mockServer.completions = [];
});
afterEach(() => jest.useRealTimers());

const STEPS = [
  ['to store', { stopIndex: 0, stage: 'NAVIGATE_STORE' }],
  ['at store', { stopIndex: 0, stage: 'NAVIGATE_STORE' }],
  ['to customer', { stopIndex: 1, stage: 'NAVIGATE_CUSTOMER' }],
  ['at door', { stopIndex: 1, stage: 'NAVIGATE_CUSTOMER' }],
];

test.each(STEPS)('cancelled by the office %s: home within 10 s, with the reason', async (_, where) => {
  const { r, onJobEnded } = await start(where);
  expect(app.job?.id).toBe('J1');

  mockServer.current = ended('J1', 'CANCELLED');
  await tick();

  expect(app.job).toBeNull();
  expect(app.jobs).toEqual([]);
  expect(app.toast).toBe('The office cancelled this order. No action needed.');
  expect(onJobEnded).toHaveBeenCalledTimes(1);
  expect(await AsyncStorage.getItem('active_delivery_v1')).toBeNull();
  act(() => r.unmount());
});

test('reassigned, closed and cleared each end the run with their own sentence', async () => {
  for (const [reason, text] of [
    ['REASSIGNED', 'This order was given to another driver. No action needed.'],
    ['CLOSED', 'The office closed this order. No action needed.'],
    ['CLEARED', 'The office took this order off you. No action needed.'],
  ]) {
    mockServer.current = carrying('J1');
    const { r } = await start();
    mockServer.current = ended('J1', reason);
    await tick();
    expect(app.job).toBeNull();
    expect(app.toast).toBe(text);
    act(() => r.unmount());
  }
});

test('an office sign-out sends the phone to sign-in', async () => {
  const { r } = await start();
  mockServer.current = () => ({ status: 401 });
  await tick();
  expect(app.token).toBeNull();
  expect(mockSecure.has('token')).toBe(false);
  act(() => r.unmount());
});

test('no signal keeps the delivery', async () => {
  const { r, onJobEnded } = await start();
  mockServer.current = () => ({ status: 0 });
  await tick();
  await tick();
  expect(app.job?.id).toBe('J1');
  expect(app.token).toBe('dt_test');
  expect(onJobEnded).not.toHaveBeenCalled();
  act(() => r.unmount());
});

test('a screen change checks at once, without waiting for the 10 s tick', async () => {
  const { r } = await start();
  mockServer.current = ended('J1', 'CANCELLED');
  await act(async () => { await app.checkNow(); });
  await flush();
  expect(app.job).toBeNull();
  act(() => r.unmount());
});

test('one order of a run cancelled: the rest carries on, at the right stop', async () => {
  const P = { kind: 'PICKUP', name: STORE.name, jobIds: ['A', 'B'], lat: STORE.latitude, lng: STORE.longitude };
  const D = (id) => ({ kind: 'DROPOFF', name: id, jobIds: [id], lat: DOOR.latitude, lng: DOOR.longitude });
  mockServer.current = carrying('A', 'B');
  const { r, onJobEnded } = await start({ jobs: [job('A'), job('B')], stops: [P, D('A'), D('B')], stopIndex: 1, stage: 'NAVIGATE_CUSTOMER' });

  mockServer.current = () => ({ status: 200, body: { jobs: [job('B')], ended: [{ jobId: 'A', reason: 'CANCELLED' }] } });
  await tick();

  expect(app.jobs.map((j) => j.id)).toEqual(['B']);
  expect(app.stopIndex).toBe(1);
  expect(app.toast).toBe('Order KFC-A was cancelled by the office. Carry on with the rest.');
  expect(onJobEnded).not.toHaveBeenCalled();
  act(() => r.unmount());
});

test('a phone that lost its delivery gets it back from dispatch', async () => {
  mockSecure.set('token', 'dt_test');
  mockSecure.set('driver', JSON.stringify({ id: 'D1' }));
  mockServer.current = () => ({ status: 200, body: { jobs: [job('J9')], stops: [], stopIndex: 1, stage: 'NAVIGATE_CUSTOMER', ended: [] } });
  let r;
  await act(async () => { r = create(<AppProvider><Probe /></AppProvider>); });
  await flush();
  expect(app.job?.id).toBe('J9');
  expect(app.stopIndex).toBe(1);
  act(() => r.unmount());
});

test('completing the first drop of a run keeps the rest of the run', async () => {
  mockServer.current = carrying('A', 'B');
  const { r } = await start({ jobs: [job('A'), job('B')], stopIndex: 1, stage: 'NAVIGATE_CUSTOMER' });
  await act(async () => { await app.completeJob({ jobId: 'A', grade: 'A' }); });
  expect(app.jobs.map((j) => [j.id, !!j.done])).toEqual([['A', true], ['B', false]]);
  expect(app.job).not.toBeNull();
  await act(async () => { await app.completeJob({ jobId: 'B', grade: 'A' }); });
  expect(app.job).toBeNull();
  expect(mockServer.completions.map((c) => c.jobId)).toEqual(['A', 'B']);
  act(() => r.unmount());
});
