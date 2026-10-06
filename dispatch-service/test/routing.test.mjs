import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { route, routeJob, routingStatus, resetRouting, point } from '../src/routing.js';
import { build } from '../src/server.js';

const STORE = { lat: -33.833, lng: 18.531 };
const HOME = { lat: -33.81, lng: 18.55 };          // ~3.1 km straight line

/** A stand-in for osrm-routed. `reply` decides each answer. */
async function fakeOsrm(t, reply) {
  let calls = 0;
  const srv = createServer((req, res) => {
    calls += 1;
    const out = reply(req.url, calls);
    if (out === 'hang') return;   // never answers
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const prev = { url: process.env.OSRM_URL, to: process.env.OSRM_TIMEOUT_MS };
  process.env.OSRM_URL = `http://127.0.0.1:${srv.address().port}`;
  process.env.OSRM_TIMEOUT_MS = '300';
  resetRouting();
  t.after(() => {
    srv.closeAllConnections?.(); srv.close();
    if (prev.url === undefined) delete process.env.OSRM_URL; else process.env.OSRM_URL = prev.url;
    if (prev.to === undefined) delete process.env.OSRM_TIMEOUT_MS; else process.env.OSRM_TIMEOUT_MS = prev.to;
    resetRouting();
  });
  return { calls: () => calls };
}
const ok = (km, min, snap = 10) => ({ body: { code: 'Ok', routes: [{ distance: km * 1000, duration: min * 60 }],
  waypoints: [{ distance: snap }, { distance: snap }] } });

test('coordinates: lat/lng or latitude/longitude; junk is refused', () => {
  assert.deepEqual(point({ latitude: '-33.8', longitude: '18.5' }), { lat: -33.8, lng: 18.5 });
  assert.equal(point({ lat: 0, lng: 0 }), null);
  assert.equal(point({ lat: 'x', lng: 1 }), null);
  assert.equal(point({ lat: 95, lng: 1 }), null);
});

test('road distance from OSRM, cached for the job after the quote', async (t) => {
  const osrm = await fakeOsrm(t, () => ok(4.2, 9));
  const a = await route(STORE, HOME);
  assert.deepEqual(a, { km: 4.2, minutes: 9, source: 'osrm' });
  const b = await route({ latitude: STORE.lat, longitude: STORE.lng }, HOME);
  assert.deepEqual(b, a);
  assert.equal(osrm.calls(), 1, 'second ask served from cache');
  assert.equal(routingStatus().cacheHits, 1);
});

test('OSRM down, slow or wrong: fall back and say so', async (t) => {
  await fakeOsrm(t, (url, n) => (n === 1 ? { status: 500, body: {} } : n === 2 ? 'hang' : { body: { code: 'NoRoute', routes: [] } }));
  for (const why of ['answered 500', 'timed out', 'NoRoute']) {
    resetRouting();
    const r = await route(STORE, { lat: HOME.lat + Math.random() / 1000, lng: HOME.lng });
    assert.equal(r.source, 'estimated');
    assert.match(routingStatus().lastError, new RegExp(why));
  }
});

test('a bad snap is not billed on', async (t) => {
  // shorter than the straight line: impossible on roads
  await fakeOsrm(t, (url, n) => (n === 1 ? ok(1.0, 3) : n === 2 ? ok(40, 50) : ok(3.5, 8, 1200)));
  assert.equal((await route(STORE, HOME)).source, 'estimated');
  resetRouting();
  assert.equal((await route(STORE, { ...HOME, lat: HOME.lat + 0.0001 })).source, 'estimated', 'absurd detour');
  resetRouting();
  assert.equal((await route(STORE, { ...HOME, lat: HOME.lat + 0.0002 })).source, 'estimated', 'point 1.2 km off any road');
});

test('a job routed on OSRM is billable; quote and job agree', async (t) => {
  await fakeOsrm(t, () => ok(4.2, 9));
  const j = await routeJob({ pickup: STORE, dropoff: HOME });
  assert.equal(j.source, 'osrm');
  assert.equal(j.deliverKm, 4.2);

  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  const body = { storeId: 'S1', zone: 'Milnerton', pickup: { latitude: STORE.lat, longitude: STORE.lng, name: 'Store' },
    dropoff: { latitude: HOME.lat, longitude: HOME.lng, name: 'Home' } };
  const q = await app.inject({ method: 'POST', url: '/v1/keychat/quote', payload: body });
  assert.equal(q.statusCode, 200);
  const job = await app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: { ...body, externalId: 'KC-R1' } });
  assert.equal(job.statusCode, 201);
  assert.equal(job.json().routing.source, 'osrm');
  assert.equal(job.json().routing.deliverKm, 4.2);
  const stored = app.engine.jobs.get(job.json().jobId);
  assert.equal(stored.pickup.lat, STORE.lat, 'latitude/longitude normalised to lat/lng');
  assert.equal(stored.pickup.name, 'Store');

  const bad = await app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: { ...body, dropoff: { lat: 0, lng: 0 } } });
  assert.equal(bad.statusCode, 400);
});
