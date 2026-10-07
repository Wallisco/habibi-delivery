// Run routing: road times for the stops on a run come from one OSRM /table
// call, cached so the dispatcher tick never waits on the network, and the
// route a driver is offered is the route they follow after accepting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { legMinutes, warmLegs, resetLegs, legStatus } from '../src/routing.js';
import { planRun } from '../src/batching.js';
import { build } from '../src/server.js';
import { SUPPLY } from '../src/supply.js';

const STORE = { lat: -33.8312, lng: 18.6512, name: 'KFC Milnerton' };
const near = (m, eastM = 0) => ({ lat: STORE.lat + m / 111000,
  lng: STORE.lng + eastM / (111000 * Math.cos((STORE.lat * Math.PI) / 180)), name: `${m} m away` });

/** A stand-in for osrm-routed's /table. `minutes(i, k)` gives each cell. */
async function fakeTable(t, minutes, snap = () => 5) {
  const urls = [];
  const srv = createServer((req, res) => {
    urls.push(req.url);
    const coords = decodeURIComponent(req.url.split('/table/v1/driving/')[1].split('?')[0]).split(';');
    const n = coords.length;
    const durations = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, k) => (i === k ? 0 : minutes(i, k) * 60)));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'Ok', durations, sources: coords.map((_, i) => ({ distance: snap(i) })) }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const prev = process.env.OSRM_URL;
  process.env.OSRM_URL = `http://127.0.0.1:${srv.address().port}`;
  resetLegs();
  t.after(() => {
    srv.closeAllConnections?.(); srv.close();
    if (prev === undefined) delete process.env.OSRM_URL; else process.env.OSRM_URL = prev;
    resetLegs();
  });
  return { urls };
}

test('without OSRM, leg times are the straight-line estimate', () => {
  resetLegs();
  const leg = legMinutes(STORE, near(1000));
  assert.equal(leg.source, 'estimated');
  assert.ok(leg.minutes > 3 && leg.minutes < 4.5, `${leg.minutes}`);
});

test('one /table call gives road times between every pair of stops', async (t) => {
  const pts = [STORE, near(400), near(800)];
  const osrm = await fakeTable(t, (i, k) => 10 * i + k);   // distinct, asymmetric
  const n = await warmLegs(pts);
  assert.equal(n, 6, 'every ordered pair');
  assert.equal(osrm.urls.length, 1);
  assert.match(osrm.urls[0], /\/table\/v1\/driving\/.+annotations=duration/);
  assert.deepEqual(legMinutes(pts[1], pts[2]), { minutes: 12, source: 'osrm' });
  assert.deepEqual(legMinutes(pts[2], pts[1]), { minutes: 21, source: 'osrm' }, 'one-way streets: A to B is not B to A');
  // Fresh pairs are not asked for again.
  await warmLegs(pts);
  assert.equal(osrm.urls.length, 1);
  assert.equal(legStatus().tableCalls, 1);
});

test('a point snapped far from any road is left on the estimate', async (t) => {
  const pts = [STORE, near(400), near(800)];
  await fakeTable(t, () => 2, (i) => (i === 2 ? 900 : 5));
  await warmLegs(pts);
  assert.equal(legMinutes(pts[0], pts[1]).source, 'osrm');
  assert.equal(legMinutes(pts[0], pts[2]).source, 'estimated');
});

test('road times change the route the planner picks', async (t) => {
  // South is nearer in a straight line (200 m against 300 m), so without road
  // times it goes first. The road says south is a long way round (a canal,
  // say) and north a 1-minute hop, so with road times north goes first.
  const north = near(300), south = near(-200);
  const jobs = [
    { id: 'S', storeId: 'KFC', pickup: STORE, dropoff: south, createdAt: Date.now() },
    { id: 'N', storeId: 'KFC', pickup: STORE, dropoff: north, createdAt: Date.now() },
  ];
  const pts = [STORE, north, south];
  const order = () => planRun(jobs).stops.map((s) => (s.kind === 'PICKUP' ? 'P' : s.jobIds[0]));
  resetLegs();
  assert.deepEqual(order(), ['P', 'S', 'N'], 'straight line: nearer first');
  await fakeTable(t, (i, k) => {
    const name = ['store', 'north', 'south'];
    const pair = `${name[i]}-${name[k]}`;
    return { 'store-north': 1, 'store-south': 6, 'north-south': 6, 'south-north': 6, 'north-store': 1, 'south-store': 6 }[pair];
  });
  await warmLegs(pts);
  const plan = planRun(jobs);
  assert.deepEqual(plan.stops.map((s) => s.kind === 'PICKUP' ? 'P' : s.jobIds[0]), ['P', 'N', 'S']);
  assert.equal(plan.source, 'osrm');
});

/* -------------------------------------------------------- through the server */

async function driver(app, phone) {
  const signin = (await app.inject({ method: 'POST', url: '/v1/driver/signin', payload: { phone, firstName: 'Sipho' } })).json();
  const id = signin.driver.id;
  const headers = { authorization: `Bearer ${signin.token}` };
  for (const d of (await app.inject({ url: `/v1/driver/${id}/account`, headers })).json().requiredDocs) {
    await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/document`, payload: { docKey: d.key, status: 'VERIFIED' } });
  }
  await app.inject({ method: 'PATCH', url: `/v1/ops/accounts/${id}`, payload: { vehicleReg: 'CA 1', zone: 'Milnerton' } });
  await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/onboarding`, payload: { state: 'ACTIVE' } });
  await app.inject({ method: 'POST', url: `/v1/driver/${id}/state`, headers, payload: { state: SUPPLY.ZONE_COMMITTED, zone: 'Milnerton' } });
  await app.inject({ method: 'POST', url: `/v1/driver/${id}/position`, headers, payload: { lat: STORE.lat, lng: STORE.lng } });
  return { id, headers };
}

test('the route offered is the route stamped on accept and shown on the shift', async (t) => {
  resetLegs();
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  const d = await driver(app, '0821234567');

  const ids = [];
  for (const m of [450, 300]) {
    const res = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
      payload: { storeId: 'KFC-MIL', zone: 'Milnerton', pickup: STORE, dropoff: near(m, 40), dispatchNow: true } });
    ids.push(res.json().jobId);
  }
  assert.equal(app.engine.dispatcher.tick(), 1, 'one stacked offer');
  const offered = app.engine.dispatcher.offers.get(ids[0]).plan.order;
  assert.deepEqual(offered, ['P:KFC-MIL', `D:${ids[1]}`, `D:${ids[0]}`], 'nearer customer first');

  const acc = await app.inject({ method: 'POST', url: `/v1/jobs/${ids[0]}/accept`, payload: { driverId: d.id } });
  assert.equal(acc.statusCode, 200);
  for (const id of ids) assert.deepEqual(app.engine.jobs.get(id).runPlan.order, offered);

  const shift = (await app.inject({ url: `/v1/driver/${d.id}/shift`, headers: d.headers })).json();
  const shown = shift.activeStops.map((s) => (s.kind === 'PICKUP' ? `P:${s.storeId}` : `D:${s.jobIds[0]}`));
  assert.deepEqual(shown, offered);
});
