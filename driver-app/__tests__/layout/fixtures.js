/**
 * Every screen in the states a driver actually sees, with realistic content:
 * real-length store and street names, a full day of trips, a busy message
 * thread. A screen that only fits when it is empty does not fit.
 *
 * `app` is what useApp() returns for the case. `header` says whether the
 * screen sits under the native-stack header (App.js).
 */
import { S as SUPPLY } from '../../src/lib/supplyState';

const noop = () => {};
const never = () => new Promise(noop);
const resolves = (v) => () => Promise.resolve(v);

const STORE = { latitude: -33.8312, longitude: 18.6512, name: 'KFC Milnerton, Koeberg Road' };
const HOME = { latitude: -33.8401, longitude: 18.6588, name: '14 Pienaar Road, Milnerton, Cape Town' };
const HOME2 = { latitude: -33.8452, longitude: 18.6623, name: '7 Racecourse Road, Milnerton' };
const HOME3 = { latitude: -33.8366, longitude: 18.6701, name: '22 Loxton Road, Milnerton Ridge' };
const AWAY = { latitude: STORE.latitude + 0.0054, longitude: STORE.longitude }; // ~600 m off

const today = { orders: 6, delivery: 312, tips: 58 };
const week = { orders: 31, delivery: 1640, tips: 270, vehicleFee: 900 };

const base = {
  driver: { id: 'D-104', name: 'Sipho' },
  zone: 'Milnerton',
  supply: SUPPLY.OFFLINE,
  offer: null,
  job: null,
  jobs: [],
  stops: null,
  stopIndex: 0,
  position: null,
  trail: [],
  online: true,
  roamingPremium: 0,
  toast: null,
  pendingSync: 0,
  earnings: { today, week },
  otpAttempts: 0,
  scanned: {},
  batchId: null,
  api: {},
  signIn: noop, signOut: noop, setSupply: noop, acceptOffer: noop, declineOffer: noop,
  toastMsg: noop, syncNow: noop, loadEarnings: noop, goToStop: noop, markJobDone: noop,
  noteOtpFail: noop, completeJob: noop, setScanned: noop,
  fetchAccount: resolves({ canWork: true }),
  fetchMessages: resolves({ messages: [], unread: 2 }),
  fetchJobs: resolves({ active: [], completed: [] }),
  sendMessage: never,
  markMessagesRead: resolves({}),
};

// A realistic order: several lines, some with sizes.
const ITEMS = [
  { name: 'Pizza Margherita', qty: 3 }, { name: 'Coke', qty: 1, size: '500ml' },
  { name: 'Sprite', qty: 1, size: '500ml' }, { name: 'Garlic bread', qty: 2 },
];
const job = (id, dropoff, extra = {}) => ({
  id, orderNumber: `KFC-${id}`, pickup: STORE, dropoff, bagCount: 2, fee: 42, distanceKm: 3.4,
  earningsPreview: { total: 48 }, items: ITEMS, itemCount: 7, ...extra,
});

const offer = {
  id: 'O-1', orderNumber: 'KFC-2291', kind: 'ZONE', fee: 52, tip: 15,
  pickup: STORE, dropoff: HOME, distanceKm: 3.4, distanceSource: 'navigation',
  bagCount: 2, readyInMinutes: 4, items: ITEMS, itemCount: 7, ageRestricted: true,
  earningsPreview: {
    total: 67,
    lines: [
      { code: 'BASE', label: 'Base fee', amount: 32 },
      { code: 'SURGE', label: 'Busy period', amount: 8 },
      { code: 'TIP', label: 'Customer tip', amount: 15 },
    ],
  },
};

const lines = [
  { code: 'BASE', label: 'Base fee', amount: 28, detail: 'Every delivery' },
  { code: 'DISTANCE', label: 'Distance', amount: 13.6, detail: '3.4 km at R4.00 a km' },
  { code: 'DELAY', label: 'Waiting at the store', amount: 8, detail: '4 min past the first 8, at R2.00 a min' },
  { code: 'TIP', label: 'Customer tip', amount: 15, fundedBy: 'customer' },
];
const completed = (i) => ({
  ...job(String(2300 + i), i % 2 ? HOME2 : HOME),
  completedAt: Date.now() - i * 45 * 60 * 1000,
  earnings: { total: 64.6, lines, waitMinutes: 12 },
  proofGrade: 'A',
  waitAtStoreMinutes: i === 2 ? 12 : 3,
});

const messages = [
  ['ops', 'Morning Sipho. KFC Koeberg is running about 10 minutes behind today.'],
  ['driver', 'Thanks, I will wait outside.'],
  ['driver', 'Customer at Pienaar Road is not answering. Gate is locked.'],
  ['ops', 'We are calling them now. Please wait 5 minutes at the gate.'],
  ['ops', 'They are coming down.'],
  ['driver', 'Delivered, thanks.'],
].map(([from, body], i) => ({
  id: `M${i}`, from, body, actor: from === 'ops' ? 'Office' : undefined,
  at: Date.now() - (6 - i) * 10 * 60 * 1000,
}));

const screen = (name) => () => require(`../../src/screens/${name}`).default;

export const CASES = [
  {
    screen: 'SignIn', state: 'empty', header: false,
    component: screen('SignInScreen'), app: () => base,
  },
  {
    screen: 'Shift', state: 'offline', header: true,
    component: screen('ShiftScreen'), app: () => base,
  },
  {
    screen: 'Shift', state: 'online', header: true,
    component: screen('ShiftScreen'),
    app: () => ({ ...base, supply: SUPPLY.ZONE_COMMITTED }),
  },
  {
    screen: 'Shift', state: 'offer', header: true,
    component: screen('ShiftScreen'),
    app: () => ({ ...base, supply: SUPPLY.ZONE_COMMITTED, offer }),
  },
  {
    screen: 'Delivery', state: 'to-store', header: true,
    component: screen('RunScreen'),
    app: () => ({ ...base, supply: SUPPLY.ZONE_COMMITTED, jobs: [job('2291', HOME)], position: AWAY }),
  },
  {
    screen: 'Delivery', state: 'pair-at-store', header: true,
    component: screen('RunScreen'),
    app: () => {
      const jobs = [job('2291', HOME), job('2292', HOME2)];
      const stop = (kind, p, ids) => ({ kind, name: p.name, lat: p.latitude, lng: p.longitude, jobIds: ids });
      return {
        ...base, supply: SUPPLY.ZONE_COMMITTED, jobs, stopIndex: 0,
        stops: [stop('PICKUP', STORE, ['2291', '2292']), stop('DROPOFF', HOME, ['2291']), stop('DROPOFF', HOME2, ['2292'])],
        position: AWAY,
      };
    },
  },
  {
    screen: 'Delivery', state: 'at-door', header: true,
    component: screen('RunScreen'),
    app: () => ({
      ...base, supply: SUPPLY.ZONE_COMMITTED, jobs: [job('2291', HOME)], stopIndex: 1,
      position: { latitude: HOME.latitude, longitude: HOME.longitude },
    }),
  },
  {
    // The tallest offer card: a next job offered at the door.
    screen: 'Delivery', state: 'next-job-offer', header: true,
    component: screen('RunScreen'),
    app: () => ({
      ...base, supply: SUPPLY.ZONE_COMMITTED, jobs: [job('2291', HOME)], stopIndex: 1,
      position: { latitude: HOME.latitude, longitude: HOME.longitude },
      offer: { ...offer, id: 'O-2', chained: true, storeFromDropoffKm: 0.8 },
    }),
  },
  {
    screen: 'Delivery', state: 'run-of-3', header: true,
    component: screen('RunScreen'),
    app: () => {
      const jobs = [job('2291', HOME), job('2292', HOME2), job('2293', HOME3)];
      const stop = (kind, p, ids) => ({ kind, name: p.name, lat: p.latitude, lng: p.longitude, jobIds: ids });
      return {
        ...base, supply: SUPPLY.ZONE_COMMITTED, jobs, stopIndex: 2,
        stops: [stop('PICKUP', STORE, ['2291', '2292', '2293']), stop('DROPOFF', HOME, ['2291']),
          stop('DROPOFF', HOME2, ['2292']), stop('DROPOFF', HOME3, ['2293'])],
        position: { latitude: HOME2.latitude, longitude: HOME2.longitude },
      };
    },
  },
  {
    screen: 'Trips', state: '8-trips', header: true,
    component: screen('JobsScreen'),
    app: () => ({
      ...base,
      fetchJobs: resolves({ active: [], completed: Array.from({ length: 8 }, (_, i) => completed(i)) }),
    }),
  },
  {
    screen: 'TripDetail', state: 'single', header: true,
    component: screen('JobDetailScreen'), app: () => base,
    params: { job: completed(1) },
  },
  {
    screen: 'TripDetail', state: 'stacked', header: true,
    component: screen('JobDetailScreen'), app: () => base,
    params: {
      job: {
        ...completed(2), bagCount: 2,
        earnings: {
          total: 81.6, waitMinutes: 12,
          lines: [...lines, { code: 'STACK', label: 'Second order on the run', amount: 17, detail: 'Same store, 1.1 km extra' }],
        },
      },
    },
  },
  {
    screen: 'Messages', state: '6-messages', header: true,
    component: screen('MessagesScreen'),
    app: () => ({ ...base, fetchMessages: resolves({ messages, unread: 0 }) }),
  },
  {
    screen: 'Earnings', state: 'loaded', header: true,
    component: screen('EarningsScreen'), app: () => base,
  },
];
