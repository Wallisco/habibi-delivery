// Offers: 45 seconds, "Offer expired" when time runs out or a late tap, and a
// second order added to the run while the driver is on the way to the store.
import React from 'react';
import { act, create } from 'react-test-renderer';
import { AppProvider, useApp, canStackOnRun } from '../src/state/store';
import OfferSheet, { OFFER_SECONDS } from '../src/components/OfferSheet';

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
const DOOR = { lat: -33.8401, lng: 18.6588, name: '14 Pienaar Road' };
const job = (id) => ({ id, orderNumber: `KFC-${id}`, pickup: STORE, dropoff: DOOR, bagCount: 1, distanceKm: 1.2 });

// Dispatch as the API client sees it.
const mockServer = { shift: () => ({ state: 'ZONE_COMMITTED', offer: null }), accept: null, declined: [] };
jest.mock('../src/lib/api', () => ({
  DEMO: false,
  makeDemoJob: () => null,
  createApi: () => ({
    current: async () => ({ jobs: [], ended: [] }),
    fetchShift: async () => mockServer.shift(),
    acceptJob: async (id) => mockServer.accept(id),
    declineJob: async (id) => { mockServer.declined.push(id); return { ok: true }; },
  }),
}));
const AsyncStorage = require('@react-native-async-storage/async-storage');

let app;
function Probe() { app = useApp(); return null; }
const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => {}); };
const tick = async (ms) => { await act(async () => { jest.advanceTimersByTime(ms); }); await flush(); };

async function start(active = null) {
  mockSecure.set('token', 'dt_test');
  mockSecure.set('driver', JSON.stringify({ id: 'D1' }));
  if (active) await AsyncStorage.setItem('active_delivery_v1', JSON.stringify(active));
  let r;
  await act(async () => {
    r = create(<AppProvider><Probe /><OfferSheet navigation={{ addListener: () => () => {} }} /></AppProvider>);
  });
  await flush();
  return r;
}
const offerFrom = (ids, extra = {}) => () => ({ state: 'ZONE_COMMITTED', offer: {
  batchId: 'RUN-1', jobId: ids[0], job: job(ids[0]), jobs: ids.map(job), stops: [], summary: {}, ...extra } });

beforeEach(async () => {
  jest.useFakeTimers();
  mockSecure.clear();
  await AsyncStorage.clear();
  mockServer.shift = () => ({ state: 'ZONE_COMMITTED', offer: null });
  mockServer.declined = [];
});
afterEach(() => jest.useRealTimers());

test('an offer gives 45 seconds, then says it expired (without declining it)', async () => {
  expect(OFFER_SECONDS).toBe(45);
  const r = await start();
  mockServer.shift = offerFrom(['A']);
  await tick(3000);                       // the offer poll
  expect(app.offer?.id).toBe('A');
  mockServer.shift = () => ({ state: 'ZONE_COMMITTED', offer: null });

  await tick(44000);
  expect(app.offer?.id).toBe('A');        // still open at 44 s
  await tick(1500);
  expect(app.offer).toBeNull();
  expect(app.toast).toBe('Offer expired.');
  expect(mockServer.declined).toEqual([]);
  act(() => r.unmount());
});

test('accepting too late shows dispatch\'s reason: "Offer expired."', async () => {
  const r = await start();
  mockServer.shift = offerFrom(['A']);
  await tick(3000);
  mockServer.accept = async () => { throw Object.assign(new Error('Offer expired'), { status: 409 }); };
  await act(async () => { await app.acceptOffer(); });
  expect(app.offer).toBeNull();
  expect(app.toast).toBe('Offer expired.');
  act(() => r.unmount());
});

test('no signal on accept says so, instead of blaming another driver', async () => {
  const r = await start();
  mockServer.shift = offerFrom(['A']);
  await tick(3000);
  mockServer.accept = async () => { throw Object.assign(new Error('timeout'), { status: 0 }); };
  await act(async () => { await app.acceptOffer(); });
  expect(app.toast).toBe('Could not reach dispatch. The offer was not accepted.');
  act(() => r.unmount());
});

test('on the run: offers keep coming only while a second order could still join', () => {
  const one = { job: job('A'), jobs: [job('A')], stopIndex: 0, stage: 'NAVIGATE_STORE' };
  expect(canStackOnRun(one)).toBe(true);
  expect(canStackOnRun({ ...one, jobs: [job('A'), job('B')] })).toBe(false);          // full: 2 orders
  expect(canStackOnRun({ ...one, stopIndex: 1, stage: 'NAVIGATE_CUSTOMER' })).toBe(false); // collected
  expect(canStackOnRun({ ...one, job: null, jobs: [] })).toBe(false);                  // nothing to stack on
});

test('on the run: a second order is offered during the delivery and joins the run', async () => {
  const r = await start({ jobs: [job('A')], stops: [], stopIndex: 0, stage: 'NAVIGATE_STORE', scanned: 0 });
  await act(async () => { await app.checkNow?.(); });
  expect(app.job?.id).toBe('A');

  mockServer.shift = offerFrom(['B'], { addsToRun: true });
  await tick(3000);
  expect(app.offer?.id).toBe('B');
  expect(app.offer.addsToRun).toBe(true);

  const P = { kind: 'PICKUP', name: STORE.name, jobIds: ['A', 'B'], lat: STORE.lat, lng: STORE.lng };
  const D = (id) => ({ kind: 'DROPOFF', name: id, jobIds: [id], lat: DOOR.lat, lng: DOOR.lng });
  mockServer.accept = async () => ({ ok: true, jobs: [job('A'), job('B')], batchId: 'RUN-1', stops: [P, D('A'), D('B')] });
  await act(async () => { await app.acceptOffer(); });

  expect(app.jobs.map((j) => j.id)).toEqual(['A', 'B']);
  expect(app.stops).toHaveLength(3);
  expect(app.stopIndex).toBe(0);
  expect(app.toast).toBe('Second order added to your run.');
  act(() => r.unmount());
});
