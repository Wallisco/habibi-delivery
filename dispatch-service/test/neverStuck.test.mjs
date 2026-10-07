// Never stuck (driver app spec, irritations 7 and 8): the app asks
// /v1/driver/current what it is carrying, the office can sign a driver out and
// clear a driver's job, and whatever the office does, the driver is freed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/server.js';
import { SUPPLY } from '../src/supply.js';

const STORE = { lat: -33.8312, lng: 18.6512, name: 'KFC Milnerton' };
const near = (m) => ({ lat: STORE.lat + m / 111000, lng: STORE.lng, name: `${m} m away` });

function appFor(t, opts = {}) {
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false, ...opts });
  t.after(() => app.close());
  return app;
}

/** A signed-in, onboarded driver, online next to the store. Returns { id, token, get, post }. */
async function driver(app, phone = '0821234567') {
  const signin = (await app.inject({ method: 'POST', url: '/v1/driver/signin',
    payload: { phone, firstName: 'Sipho' } })).json();
  const id = signin.driver.id;
  const headers = { authorization: `Bearer ${signin.token}` };
  const get = (url) => app.inject({ url, headers });
  const post = (url, payload) => app.inject({ method: 'POST', url, payload, headers });
  for (const d of (await get(`/v1/driver/${id}/account`)).json().requiredDocs) {
    await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/document`, payload: { docKey: d.key, status: 'VERIFIED' } });
  }
  await app.inject({ method: 'PATCH', url: `/v1/ops/accounts/${id}`, payload: { vehicleReg: 'CA 1', zone: 'Milnerton' } });
  await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/onboarding`, payload: { state: 'ACTIVE' } });
  await post(`/v1/driver/${id}/state`, { state: SUPPLY.ZONE_COMMITTED, zone: 'Milnerton' });
  await post(`/v1/driver/${id}/position`, { lat: STORE.lat, lng: STORE.lng });
  return { id, token: signin.token, get, post };
}

async function order(app, m = 1500, extra = {}) {
  const res = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'KFC-MIL', zone: 'Milnerton', pickup: STORE, dropoff: near(m), dispatchNow: true, ...extra } });
  assert.equal(res.statusCode, 201);
  return res.json().jobId;
}

/** Offer and accept one order. */
async function take(app, d, m) {
  const jobId = await order(app, m);
  assert.equal(app.engine.dispatcher.tick(), 1);
  const res = await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/accept`, payload: { driverId: d.id } });
  assert.equal(res.statusCode, 200);
  return jobId;
}

const current = async (d, held = []) => {
  const res = await d.get(`/v1/driver/current${held.length ? `?jobs=${held.join(',')}` : ''}`);
  assert.equal(res.statusCode, 200);
  return res.json();
};

/** Move a job to each delivery step, the way the app does. */
const STEPS = {
  'to store': async () => {},
  'at store': async (app, jobId) => { await app.inject({ method: 'POST', url: `/v1/keychat/jobs/${jobId}/ready` }); },
  'to customer': async (app, jobId) => { await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/collect` }); },
  'at door': async (app, jobId) => {
    await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/collect` });
    await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/approach` });
  },
};

/* ------------------------------------------------------------- /current */

test('/current needs a token, and shows what the driver is carrying', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  assert.equal((await app.inject({ url: '/v1/driver/current' })).statusCode, 401);

  assert.deepEqual(await current(d), { jobs: [], batchId: null, stops: [], stopIndex: 0, stage: null, ended: [] });
  const jobId = await take(app, d);
  let cur = await current(d, [jobId]);
  assert.deepEqual(cur.jobs.map((j) => j.id), [jobId]);
  assert.equal(cur.stage, 'NAVIGATE_STORE');
  assert.equal(cur.stopIndex, 0);
  assert.deepEqual(cur.ended, []);
  assert.equal(cur.jobs[0].code, undefined, 'the delivery code never reaches the driver');

  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/collect` });
  cur = await current(d, [jobId]);
  assert.equal(cur.stage, 'NAVIGATE_CUSTOMER');
  assert.equal(cur.stopIndex, 1, 'collected: the drop-off is next');
});

test('a phone that lost its job (reinstall, restart) gets it back from /current', async (t) => {
  const path = join(mkdtempSync(join(tmpdir(), 'dispatch-current-')), 'd.db');
  let app = build({ dbPath: path, partnerAuth: false, opsAuth: false });
  const d = await driver(app);
  const jobId = await take(app, d);
  await app.close();

  // The server restarted too: the supply record comes back empty (by design),
  // but the driver is still carrying the job.
  app = build({ dbPath: path, partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  const res = await app.inject({ url: '/v1/driver/current', headers: { authorization: `Bearer ${d.token}` } });
  assert.deepEqual(res.json().jobs.map((j) => j.id), [jobId]);
  assert.equal(app.engine.supply.get(d.id).activeJobId, jobId,
    'and dispatch knows they are busy, so it cannot offer them a second job');
});

for (const [step, goTo] of Object.entries(STEPS)) {
  test(`cancelled by the office ${step}: /current says CANCELLED and the driver is free`, async (t) => {
    const app = appFor(t);
    const d = await driver(app);
    const jobId = await take(app, d);
    await goTo(app, jobId);
    const res = await app.inject({ method: 'POST', url: `/v1/ops/orders/${jobId}/close`,
      payload: { outcome: 'CANCELLED', reason: 'Customer cancelled' } });
    assert.equal(res.statusCode, 200);

    const cur = await current(d, [jobId]);
    assert.deepEqual(cur.jobs, []);
    assert.deepEqual(cur.ended.map((e) => [e.jobId, e.reason]), [[jobId, 'CANCELLED']]);
    assert.equal(app.engine.supply.get(d.id).activeJobId, null);
  });
}

test('closed by the office (failed, or marked delivered by hand) says CLOSED', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  const failed = await take(app, d, 1200);
  await app.inject({ method: 'POST', url: `/v1/ops/orders/${failed}/close`, payload: { outcome: 'FAILED', reason: 'No one home' } });
  const byHand = await take(app, d, 1300);
  await app.inject({ method: 'POST', url: `/v1/ops/orders/${byHand}/close`, payload: { outcome: 'DELIVERED', reason: 'Confirmed by phone' } });
  const cur = await current(d, [failed, byHand]);
  assert.deepEqual(cur.ended.map((e) => e.reason), ['CLOSED', 'CLOSED']);
});

test('reassigned by the office says REASSIGNED, even once another driver has it', async (t) => {
  const app = appFor(t);
  const me = await driver(app, '0821111111');
  const jobId = await take(app, me);
  await app.inject({ method: 'POST', url: `/v1/ops/orders/${jobId}/reassign`, payload: { reason: 'Bike broke down' } });
  assert.equal((await current(me, [jobId])).ended[0].reason, 'REASSIGNED');
  assert.equal(app.engine.supply.get(me.id).activeJobId, null);

  // It is never offered back to me; someone else gets it.
  assert.equal(app.engine.dispatcher.tick(), 0, 'not re-offered to the driver it was taken from');
  const other = await driver(app, '0822222222');
  assert.equal(app.engine.dispatcher.tick(), 1);
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/accept`, payload: { driverId: other.id } });
  assert.equal((await current(me, [jobId])).ended[0].reason, 'REASSIGNED');
  assert.deepEqual((await current(other, [jobId])).jobs.map((j) => j.id), [jobId]);
});

test('a job this driver delivered is a normal finish, not an office action', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  const jobId = await take(app, d);
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/collect` });
  const job = app.engine.jobs.get(jobId);
  await app.inject({ method: 'POST', url: '/v1/jobs/complete',
    payload: { jobId, grade: 'A', position: job.dropoff, gpsTrail: [job.dropoff] } });
  assert.deepEqual((await current(d, [jobId])).ended.map((e) => e.reason), ['DELIVERED']);
});

test('in a run of three, one cancelled order leaves the other two', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  const ids = [await order(app, 800), await order(app, 1100), await order(app, 1400)];
  // Put the run on the driver directly: this test is about what happens after.
  for (const id of ids) app.engine.jobs.setStatus(id, 'ASSIGNED', { driverId: d.id, batchId: 'B-1' });
  app.engine.supply.upsert(d.id, { activeJobId: ids[0], activeBatchId: 'B-1' });

  let cur = await current(d, ids);
  assert.equal(cur.jobs.length, 3);
  assert.equal(cur.stops[cur.stopIndex].kind, 'PICKUP');

  await app.inject({ method: 'POST', url: `/v1/ops/orders/${ids[0]}/close`, payload: { outcome: 'CANCELLED', reason: 'test' } });
  cur = await current(d, ids);
  assert.deepEqual(cur.jobs.map((j) => j.id), [ids[1], ids[2]]);
  assert.deepEqual(cur.ended.map((e) => [e.jobId, e.reason]), [[ids[0], 'CANCELLED']]);
  const s = app.engine.supply.get(d.id);
  assert.equal(s.activeJobId, ids[1], 'still busy with the rest of the run');
  assert.equal(s.activeBatchId, 'B-1');
});

/* ------------------------------------------------------------ sign-out */

test('office sign-out: the phone gets 401 on its next call, and goes offline', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  assert.equal((await d.get('/v1/driver/current')).statusCode, 200);

  assert.equal((await app.inject({ method: 'POST', url: `/v1/ops/drivers/${d.id}/sign-out`, payload: {} })).statusCode, 400,
    'a reason is required');
  const res = await app.inject({ method: 'POST', url: `/v1/ops/drivers/${d.id}/sign-out`,
    payload: { reason: 'App stuck in a loop', actor: 'Thandi' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().revoked, 1);

  assert.equal((await d.get('/v1/driver/current')).statusCode, 401);
  assert.equal((await d.get(`/v1/driver/${d.id}/shift`)).statusCode, 401);
  assert.equal(app.engine.supply.get(d.id).state, SUPPLY.OFFLINE);
  assert.equal(app.engine.dispatcher.tick(), 0);
  const note = app.engine.accounts.get(d.id).notes.at(-1);
  assert.equal(note.text, 'Signed out by the office: App stuck in a loop');
  assert.equal(note.actor, 'Thandi');
});

test('sign-out tells the office about a job the driver still carries, and withdraws offers', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  const carried = await take(app, d);
  const res = await app.inject({ method: 'POST', url: `/v1/ops/drivers/${d.id}/sign-out`, payload: { reason: 'test' } });
  assert.deepEqual(res.json().activeJobs, [carried]);

  const app2 = appFor(t);
  const d2 = await driver(app2);
  const offered = await order(app2);
  assert.equal(app2.engine.dispatcher.tick(), 1);
  await app2.inject({ method: 'POST', url: `/v1/ops/drivers/${d2.id}/sign-out`, payload: { reason: 'test' } });
  assert.equal(app2.engine.dispatcher.offers.has(offered), false, 'the open offer is withdrawn');
  assert.equal(app2.engine.jobs.get(offered).status, 'PENDING');
});

test('sign-out and clear-job need an ops or admin login', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false });
  t.after(() => app.close());
  const users = app.engine.opsUsers;
  users.add({ email: 'v@x.co', name: 'Viewer', role: 'viewer', password: 'long-enough-1' });
  users.add({ email: 'o@x.co', name: 'Ops', role: 'ops', password: 'long-enough-1' });
  const cookie = async (email) => (await app.inject({ method: 'POST', url: '/v1/ops/login',
    payload: { email, password: 'long-enough-1' } })).headers['set-cookie'].split(';')[0];
  const { driver: { id } } = (await app.inject({ method: 'POST', url: '/v1/driver/signin', payload: { phone: '0821234567' } })).json();

  const signOut = (headers) => app.inject({ method: 'POST', url: `/v1/ops/drivers/${id}/sign-out`, payload: { reason: 'r' }, headers });
  assert.equal((await signOut({})).statusCode, 401);
  assert.equal((await signOut({ cookie: await cookie('v@x.co') })).statusCode, 403);
  assert.equal((await signOut({ cookie: await cookie('o@x.co') })).statusCode, 200);
  const clear = await app.inject({ method: 'POST', url: `/v1/ops/drivers/${id}/clear-job`,
    payload: { action: 'requeue', reason: 'r' }, headers: { cookie: await cookie('v@x.co') } });
  assert.equal(clear.statusCode, 403);
});

/* ----------------------------------------------------------- clear-job */

test('clear-job requeue sends the order back to dispatch and frees the driver', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  const jobId = await take(app, d);
  const bad = await app.inject({ method: 'POST', url: `/v1/ops/drivers/${d.id}/clear-job`, payload: { action: 'requeue' } });
  assert.equal(bad.statusCode, 400, 'a reason is required');

  const res = await app.inject({ method: 'POST', url: `/v1/ops/drivers/${d.id}/clear-job`,
    payload: { action: 'requeue', reason: 'Driver stuck at the store' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().jobs, [jobId]);
  assert.equal(app.engine.jobs.get(jobId).status, 'PENDING');
  assert.equal(app.engine.jobs.get(jobId).driverId, null);
  assert.equal(app.engine.supply.get(d.id).activeJobId, null);
  assert.deepEqual((await current(d, [jobId])).ended.map((e) => e.reason), ['CLEARED']);

  const again = await app.inject({ method: 'POST', url: `/v1/ops/drivers/${d.id}/clear-job`,
    payload: { action: 'requeue', reason: 'again' } });
  assert.equal(again.statusCode, 409, 'nothing left to clear');
});

test('clear-job will not requeue collected food, but can close it', async (t) => {
  const app = appFor(t);
  const d = await driver(app);
  const jobId = await take(app, d);
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/collect` });

  const requeue = await app.inject({ method: 'POST', url: `/v1/ops/drivers/${d.id}/clear-job`,
    payload: { action: 'requeue', reason: 'stuck' } });
  assert.equal(requeue.statusCode, 409);
  assert.deepEqual(requeue.json().collected, [jobId]);

  const close = await app.inject({ method: 'POST', url: `/v1/ops/drivers/${d.id}/clear-job`,
    payload: { action: 'close', outcome: 'FAILED', reason: 'Food spilled' } });
  assert.equal(close.statusCode, 200);
  assert.equal(app.engine.jobs.get(jobId).status, 'FAILED');
  assert.equal(app.engine.jobs.get(jobId).failReason, 'Food spilled');
  assert.deepEqual((await current(d, [jobId])).ended.map((e) => e.reason), ['CLEARED']);
  assert.equal(app.engine.supply.get(d.id).activeJobId, null);
});

/* ------------------------------------------------- staging: simulator */

async function runUntil(app, done, { stepMs = 1000, maxMs = 10 * 60 * 1000 } = {}) {
  const { dispatcher, sim } = app.engine;
  const t0 = Date.now();
  for (let t = 0; t <= maxMs; t += stepMs) {
    dispatcher.tick(t0 + t);
    await sim.step(t0 + t);
    if (done()) return t;
  }
  throw new Error('simulation did not finish');
}

test('staging: a simulated driver drops a job the office reassigns', async (t) => {
  const app = appFor(t, { staging: true });
  const jobId = await order(app, 1500, { externalId: 'KC-NS-1' });
  await runUntil(app, () => app.engine.jobs.get(jobId).status === 'ASSIGNED');
  const simId = app.engine.jobs.get(jobId).driverId;
  await app.inject({ method: 'POST', url: `/v1/ops/orders/${jobId}/reassign`, payload: { reason: 'test' } });
  await runUntil(app, () => !app.engine.sim.runs.has(simId), { maxMs: 5000 });
  assert.ok(!app.engine.jobs.get(jobId).collectedAt, 'it did not carry on and collect it');
});

test('staging: an office sign-out stops a simulated driver mid-delivery', async (t) => {
  const app = appFor(t, { staging: true });
  const jobId = await order(app, 1500, { externalId: 'KC-NS-2' });
  await runUntil(app, () => app.engine.jobs.get(jobId).status === 'ASSIGNED');
  const simId = app.engine.jobs.get(jobId).driverId;
  await app.inject({ method: 'POST', url: `/v1/ops/drivers/${simId}/sign-out`, payload: { reason: 'demo' } });
  await runUntil(app, () => !app.engine.sim.runs.has(simId), { maxMs: 5000 });
  assert.equal(app.engine.jobs.get(jobId).status, 'ASSIGNED', 'stopped where it was');
});

test('staging: NOSIM orders are left for a real phone', async (t) => {
  const app = appFor(t, { staging: true });
  // A simulated driver is already standing at this store from an earlier order.
  await order(app, 900, { externalId: 'KC-NS-3' });
  const real = await driver(app);
  const jobId = await order(app, 1500, { externalId: 'KC-NS-4-NOSIM' });
  await runUntil(app, () => app.engine.dispatcher.offers.get(jobId)?.driverId === real.id, { maxMs: 60000 });
  assert.equal(app.engine.jobs.get(jobId).status, 'OFFERED');
});
