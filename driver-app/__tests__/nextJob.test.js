// Next job: with one collected order on board, dispatch may line up one next
// order. The run in the box is unchanged; after the drop the next job starts;
// if the drop runs long, dispatch takes the next job back and the driver is told.
import React from 'react';
import { act, create } from 'react-test-renderer';
import { AppProvider, useApp, canChainOnRun } from '../src/state/store';
import OfferSheet from '../src/components/OfferSheet';

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
jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { WebView: ({ style }) => React.createElement(View, { style }) };
});

const STORE = { lat: -33.8312, lng: 18.6512, name: 'KFC Milnerton' };
const SPUR = { lat: -33.8318, lng: 18.6520, name: 'Spur Milnerton' };
const DOOR = { lat: -33.8401, lng: 18.6588, name: '14 Pienaar Road' };
const job = (id, pickup = STORE) => ({ id, orderNumber: `KFC-${id}`, pickup, dropoff: DOOR, bagCount: 1, distanceKm: 1.2 });

const mockServer = {
  shift: () => ({ state: 'ZONE_COMMITTED', offer: null }),
  current: () => ({ jobs: [], ended: [], next: null }),
  accept: null,
};
jest.mock('../src/lib/api', () => ({
  DEMO: false,
  makeDemoJob: () => null,
  createApi: () => ({
    current: async () => mockServer.current(),
    fetchShift: async () => mockServer.shift(),
    acceptJob: async (id) => mockServer.accept(id),
    declineJob: async () => ({ ok: true }),
    postCompletion: async () => ({ ok: true }),
  }),
}));
const AsyncStorage = require('@react-native-async-storage/async-storage');

let app;
function Probe() { app = useApp(); return null; }
const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => {}); };
const tick = async (ms) => { await act(async () => { jest.advanceTimersByTime(ms); }); await flush(); };

/** On the way to the customer with order A in the box. */
async function carryingA() {
  mockSecure.set('token', 'dt_test');
  mockSecure.set('driver', JSON.stringify({ id: 'D1' }));
  await AsyncStorage.setItem('active_delivery_v1', JSON.stringify(
    { jobs: [job('A')], stops: [], stopIndex: 1, stage: 'NAVIGATE_CUSTOMER', scanned: 1 }));
  mockServer.current = () => ({ jobs: [job('A')], ended: [], next: null, stopIndex: 1, stage: 'NAVIGATE_CUSTOMER' });
  let r;
  await act(async () => {
    r = create(<AppProvider><Probe /><OfferSheet navigation={{ addListener: () => () => {} }} /></AppProvider>);
  });
  await flush();
  expect(app.job?.id).toBe('A');
  return r;
}

async function lineUpB() {
  mockServer.shift = () => ({ state: 'ZONE_COMMITTED', offer: {
    batchId: 'RUN-2', jobId: 'B', job: job('B', SPUR), jobs: [job('B', SPUR)], stops: [], summary: {},
    addsToRun: false, next: { afterJobId: 'A', freeInMinutes: 6, waitAtStoreMinutes: 2 } } });
  await tick(3000);
  expect(app.offer?.id).toBe('B');
  expect(app.offer.next.freeInMinutes).toBe(6);
  mockServer.shift = () => ({ state: 'ZONE_COMMITTED', offer: null });
  mockServer.accept = async () => ({ ok: true, job: job('A'), jobs: [job('A')], next: job('B', SPUR), stops: [] });
  await act(async () => { await app.acceptOffer(); });
  mockServer.current = () => ({ jobs: [job('A')], ended: [], next: job('B', SPUR), stopIndex: 1, stage: 'NAVIGATE_CUSTOMER' });
}

beforeEach(async () => {
  jest.useFakeTimers();
  mockSecure.clear();
  await AsyncStorage.clear();
  mockServer.shift = () => ({ state: 'ZONE_COMMITTED', offer: null });
});
afterEach(() => jest.useRealTimers());

test('a next job is only possible with one collected order on board and nothing lined up', () => {
  const one = { job: job('A'), jobs: [job('A')], stopIndex: 1, stage: 'NAVIGATE_CUSTOMER', next: null };
  expect(canChainOnRun(one)).toBe(true);
  expect(canChainOnRun({ ...one, stopIndex: 0, stage: 'NAVIGATE_STORE' })).toBe(false);    // not collected
  expect(canChainOnRun({ ...one, jobs: [job('A'), job('C')] })).toBe(false);               // a stacked run
  expect(canChainOnRun({ ...one, next: job('B') })).toBe(false);                           // one at a time
});

test('accepting a next job leaves the delivery in progress exactly as it was', async () => {
  const r = await carryingA();
  await lineUpB();
  expect(app.jobs.map((j) => j.id)).toEqual(['A']);
  expect(app.stopIndex).toBe(1);
  expect(app.stage).toBe('NAVIGATE_CUSTOMER');
  expect(app.next?.id).toBe('B');
  expect(app.toast).toBe('Next job lined up: collect at Spur Milnerton after this drop.');
  act(() => r.unmount());
});

test('after the drop, the next job starts straight away', async () => {
  const r = await carryingA();
  await lineUpB();
  await act(async () => { await app.completeJob({ jobId: 'A', grade: 'A' }); });
  expect(app.jobs.map((j) => j.id)).toEqual(['B']);
  expect(app.stopIndex).toBe(0);
  expect(app.stage).toBe('NAVIGATE_STORE');
  expect(app.next).toBeNull();
  expect(app.toast).toBe('On to your next job: collect at Spur Milnerton.');

  // Dispatch agrees: B is the driver's job now. Nothing changes on the phone.
  mockServer.current = () => ({ jobs: [job('B', SPUR)], ended: [], next: null, stopIndex: 0, stage: 'NAVIGATE_STORE' });
  await act(async () => { await app.checkNow(); });
  expect(app.jobs.map((j) => j.id)).toEqual(['B']);
  act(() => r.unmount());
});

test('a drop that runs long: dispatch takes the next job back and the driver is told', async () => {
  const r = await carryingA();
  await lineUpB();
  mockServer.current = () => ({ jobs: [job('A')], ended: [], next: null, stopIndex: 1, stage: 'NAVIGATE_CUSTOMER' });
  await act(async () => { await app.checkNow(); });
  expect(app.next).toBeNull();
  expect(app.jobs.map((j) => j.id)).toEqual(['A']);
  expect(app.toast).toMatch(/next job went to another driver/);
  act(() => r.unmount());
});
