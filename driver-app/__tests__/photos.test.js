// The collection photo: required before "I have all the bags", queued when
// there is no signal, and only ever sent with the driver's own token.
import React from 'react';
import { act, create } from 'react-test-renderer';
import { enqueuePhoto, drainPhotos, readPhotos } from '../src/lib/photoQueue';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
const AsyncStorage = require('@react-native-async-storage/async-storage');

jest.mock('../src/state/store', () => ({ useApp: () => global.__photoApp }));
jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { WebView: ({ style }) => React.createElement(View, { style }) };
});

const refuse = (status) => async () => { throw Object.assign(new Error(`status ${status}`), { status }); };

beforeEach(() => AsyncStorage.clear());

/* ------------------------------------------------------------------ queue */

test('a photo taken with no signal waits, and uploads when there is signal', async () => {
  await enqueuePhoto({ uri: 'file:///a.jpg', jobIds: ['J1'], driverId: 'D1' });
  let res = await drainPhotos({ uploadCollectionPhoto: refuse(0) }, 'D1');
  expect(res.remaining).toBe(1);
  expect((await readPhotos('D1'))[0].attempts).toBe(1);

  const sent = [];
  res = await drainPhotos({ uploadCollectionPhoto: async (uri, ids) => { sent.push([uri, ids]); } }, 'D1');
  expect(res).toMatchObject({ uploaded: 1, remaining: 0 });
  expect(sent).toEqual([['file:///a.jpg', ['J1']]]);
});

test('a photo dispatch refuses for good is dropped; a 401 keeps it for the next sign-in', async () => {
  await enqueuePhoto({ uri: 'file:///a.jpg', jobIds: ['J1'], driverId: 'D1' });
  expect((await drainPhotos({ uploadCollectionPhoto: refuse(401) }, 'D1')).unauthorized).toBe(true);
  expect(await readPhotos('D1')).toHaveLength(1);
  expect((await drainPhotos({ uploadCollectionPhoto: refuse(403) }, 'D1')).dropped).toBe(1);
  expect(await readPhotos('D1')).toHaveLength(0);
});

test("another driver's photo is never sent with my token", async () => {
  await enqueuePhoto({ uri: 'file:///theirs.jpg', jobIds: ['J9'], driverId: 'D9' });
  const sent = [];
  await drainPhotos({ uploadCollectionPhoto: async (uri) => { sent.push(uri); } }, 'D1');
  expect(sent).toEqual([]);
  expect(await readPhotos('D9')).toHaveLength(1);
});

/* ------------------------------------------------------------ store step */

const STORE = { latitude: -33.8312, longitude: 18.6512, name: 'KFC Milnerton' };
const job = { id: 'J1', orderNumber: 'KFC-1', pickup: STORE,
  dropoff: { latitude: -33.84, longitude: 18.66, name: '14 Pienaar Road, Milnerton' },
  bagCount: 2, items: [{ name: 'Pizza', qty: 3 }, { name: 'Coke', qty: 1, size: '500ml' }] };

function appAtStore(takeCollectionPhoto) {
  const noop = () => {};
  return {
    jobs: [job], stops: [], stopIndex: 0, position: { latitude: STORE.latitude, longitude: STORE.longitude },
    trail: [], online: true, otpAttempts: 0, scanned: 0, batchId: null, toast: null, api: { collect: jest.fn() },
    goToStop: jest.fn(), markJobDone: noop, noteOtpFail: noop, completeJob: noop, toastMsg: noop,
    setScanned: noop, takeCollectionPhoto, offer: null, acceptOffer: noop, declineOffer: noop, expireOffer: noop,
  };
}
/** The button whose label is exactly `label`. */
const button = (r, label) => r.root.findAll((n) => n.props.accessibilityRole === 'button'
  && n.findAll((c) => c.props.children === label).length > 0)[0];
const collectButton = (r) => button(r, 'I have all 2 bags');

async function renderAtStore(app) {
  global.__photoApp = app;
  const RunScreen = require('../src/screens/RunScreen').default;
  let r;
  await act(async () => { r = create(<RunScreen navigation={{ navigate() {}, addListener: () => () => {}, setOptions() {} }} />); });
  return r;
}
const advance = async (ms) => { await act(async () => { jest.advanceTimersByTime(ms); }); await act(async () => {}); };

test('photo check trial: the driver sees "Checking", then what was not seen, and can still collect', async () => {
  jest.useFakeTimers();
  const answers = [
    { checks: { J1: { status: 'pending', missing: [] } } },
    { checks: { J1: { status: 'missing', missing: [{ name: 'Sprite', qty: 1 }], note: null } } },
  ];
  const photoCheck = jest.fn(async () => answers.shift() ?? answers[answers.length - 1]);
  const app = appAtStore(jest.fn(async () => 'file:///order.jpg'));
  app.jobs = [{ ...job, photoCheck: true }];
  app.api = { collect: jest.fn(), photoCheck };
  const r = await renderAtStore(app);
  const text = () => JSON.stringify(r.toJSON());

  await act(async () => { await button(r, 'Take a photo of the order').props.onPress(); });
  expect(text()).toContain('Checking your photo…');
  await advance(2000);
  expect(text()).toContain('Checking your photo…');
  await advance(2000);
  expect(text()).toContain('Not seen in your photo: 1 × Sprite. Check before you leave.');
  expect(photoCheck).toHaveBeenCalledWith(['J1']);
  expect(collectButton(r).props.accessibilityState.disabled).toBe(false);   // never blocks
  act(() => r.unmount());
  jest.useRealTimers();
});

test("photo check trial: a match says so; a store that isn't in the trial never asks", async () => {
  jest.useFakeTimers();
  const photoCheck = jest.fn(async () => ({ checks: { J1: { status: 'complete', missing: [] } } }));
  const on = appAtStore(jest.fn(async () => 'file:///order.jpg'));
  on.jobs = [{ ...job, photoCheck: true }];
  on.api = { collect: jest.fn(), photoCheck };
  let r = await renderAtStore(on);
  await act(async () => { await button(r, 'Take a photo of the order').props.onPress(); });
  await advance(2000);
  expect(JSON.stringify(r.toJSON())).toContain('Photo matches the order.');
  act(() => r.unmount());

  const asked = jest.fn();
  const off = appAtStore(jest.fn(async () => 'file:///order.jpg'));
  off.api = { collect: jest.fn(), photoCheck: asked };
  r = await renderAtStore(off);
  await act(async () => { await button(r, 'Take a photo of the order').props.onPress(); });
  await advance(10000);
  expect(asked).not.toHaveBeenCalled();
  expect(JSON.stringify(r.toJSON())).not.toContain('Checking your photo');
  act(() => r.unmount());
  jest.useRealTimers();
});

test('at the store, "I have all the bags" stays locked until the photo is taken', async () => {
  jest.useFakeTimers();
  const take = jest.fn(async () => 'file:///order.jpg');
  global.__photoApp = appAtStore(take);
  const RunScreen = require('../src/screens/RunScreen').default;
  let r;
  await act(async () => { r = create(<RunScreen navigation={{ navigate() {}, addListener: () => () => {} }} />); });

  const text = () => JSON.stringify(r.toJSON());
  expect(text()).toContain('3 × Pizza');
  expect(text()).toContain('1 × Coke 500ml');
  expect(collectButton(r).props.accessibilityState.disabled).toBe(true);
  expect(text()).toContain('Take the photo first.');

  await act(async () => { await button(r, 'Take a photo of the order').props.onPress(); });
  expect(take).toHaveBeenCalledWith(['J1']);
  expect(text()).toContain('Photo taken');
  expect(collectButton(r).props.accessibilityState.disabled).toBe(false);
  act(() => r.unmount());
  jest.useRealTimers();
});
