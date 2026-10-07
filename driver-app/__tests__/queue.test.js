// The offline completion queue: per driver, and never stuck behind a
// completion dispatch will refuse forever.
import { enqueue, drain, readQueue, isBlocked, MAX_UNSYNCED } from '../src/lib/queue';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
const AsyncStorage = require('@react-native-async-storage/async-storage');

const refuse = (status) => async () => { throw Object.assign(new Error(`status ${status}`), { status }); };

beforeEach(() => AsyncStorage.clear());

test("another driver's completions are never sent with my token, and don't block me", async () => {
  for (let i = 0; i < MAX_UNSYNCED; i += 1) await enqueue({ jobId: `A${i}` }, 'DRIVER-A');
  expect((await isBlocked('DRIVER-A')).blocked).toBe(true);
  expect((await isBlocked('DRIVER-B')).blocked).toBe(false);

  const sent = [];
  const res = await drain({ postCompletion: async (e) => { sent.push(e.jobId); return { accepted: true }; } }, 'DRIVER-B');
  expect(sent).toEqual([]);
  expect(res.remaining).toBe(0);
  expect((await readQueue()).length).toBe(MAX_UNSYNCED);
});

test('a completion refused for good (order cancelled meanwhile) is dropped, not retried forever', async () => {
  await enqueue({ jobId: 'J1' }, 'D1');
  await enqueue({ jobId: 'J2' }, 'D1');
  const res = await drain({ postCompletion: refuse(409) }, 'D1');
  expect(res).toMatchObject({ synced: 0, rejected: 2, remaining: 0 });
  expect(await readQueue('D1')).toEqual([]);
});

test('no signal keeps it, and counts the attempt', async () => {
  await enqueue({ jobId: 'J1' }, 'D1');
  const res = await drain({ postCompletion: refuse(0) }, 'D1');
  expect(res.remaining).toBe(1);
  expect((await readQueue('D1'))[0].attempts).toBe(1);
});

test('signed out (401): keep everything for when the driver signs in again', async () => {
  await enqueue({ jobId: 'J1' }, 'D1');
  await enqueue({ jobId: 'J2' }, 'D1');
  let calls = 0;
  const res = await drain({ postCompletion: async () => { calls += 1; throw Object.assign(new Error('x'), { status: 401 }); } }, 'D1');
  expect(res.unauthorized).toBe(true);
  expect(calls).toBe(1);
  expect((await readQueue('D1')).map((i) => i.jobId)).toEqual(['J1', 'J2']);
});

test('items queued before drivers were tagged still sync for whoever is signed in', async () => {
  await AsyncStorage.setItem('pending_completions_v1', JSON.stringify([{ jobId: 'OLD', queuedAt: Date.now(), attempts: 0 }]));
  const res = await drain({ postCompletion: async () => ({ accepted: true }) }, 'D1');
  expect(res.synced).toBe(1);
});
