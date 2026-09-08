import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { build } from '../src/server.js';
import { SUPPLY } from '../src/supply.js';

/**
 * Sign a driver in and take them all the way through onboarding.
 * Dispatch refuses un-verified drivers, which is the point, so every test that
 * needs a working driver has to do this.
 */
async function onboard(app, phone = '0821234567', zone = 'Durbanville') {
  const res = await app.inject({ method: 'POST', url: '/v1/driver/signin',
    payload: { phone, firstName: 'Test', lastName: 'Driver' } });
  const id = res.json().driver.id;
  const docs = (await app.inject({ url: `/v1/driver/${id}/account` })).json().requiredDocs;
  for (const d of docs) {
    await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/document`,
      payload: { docKey: d.key, status: 'VERIFIED' } });
  }
  await app.inject({ method: 'PATCH', url: `/v1/ops/accounts/${id}`,
    payload: { vehicleReg: 'CA 123-456', zone } });
  await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/onboarding`,
    payload: { state: 'ACTIVE' } });
  return id;
}

/**
 * A unique file per run.
 *
 * Windows will not delete a file while a handle is open, and SQLite in WAL
 * mode keeps -wal and -shm alongside the database. Sharing one path across
 * tests meant a leftover handle from the previous test failed the next one --
 * on Linux, where deletes succeed regardless, this was invisible.
 */
const DBP = `./data/test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.db`;
const DBN = { lat: -33.8312, lng: 18.6512 };
const near = (m) => ({ lat: DBN.lat + m / 111000, lng: DBN.lng });

/**
 * Best effort. A file we cannot delete is a temp file left behind, which is
 * untidy; failing the test over it would be worse, and would hide the result
 * the test actually exists to check.
 */
function clean() {
  for (const f of [DBP, `${DBP}-wal`, `${DBP}-shm`]) {
    try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* still locked */ }
  }
}

/** Close a database without caring whether it was already closed. */
function shut(app) {
  try { app.engine.db.close(); } catch { /* already closed */ }
}

test('state survives a restart', async (t) => {
  clean();
  t.after(clean);

  /* ---------------------------------------------- first process lifetime */
  let app = build({ dbPath: DBP });

  const driverId = await onboard(app, '0821234567', 'Milnerton');
  await app.inject({ method: 'POST', url: `/v1/driver/${driverId}/state`,
    payload: { state: SUPPLY.ZONE_COMMITTED, zone: 'Milnerton' } });

  // Teach the ready gate about a fast store.
  for (let i = 0; i < 12; i++) {
    app.engine.gate.observe('MILNERTON-GALLERIA', 6, { source: 'print' });
  }
  const predictedBefore = app.engine.gate.predictPrepMinutes('MILNERTON-GALLERIA');
  assert.ok(predictedBefore < 10, 'gate learned the store is fast');

  const created = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'MILNERTON-GALLERIA', zone: 'Milnerton',
      pickup: DBN, dropoff: near(1500), fee: 42, createdAt: Date.now() - 600000 } });
  const jobId = created.json().jobId;

  shut(app);
  await app.close();

  /* --------------------------------------------- second process lifetime */
  app = build({ dbPath: DBP });
  t.after(async () => { shut(app); await app.close(); });

  const stats = (await app.inject({ url: '/v1/ops/stats' })).json();

  assert.equal(stats.restoredOnBoot.drivers, 1, 'driver restored');
  assert.equal(stats.restoredOnBoot.jobs, 1, 'open job restored');
  assert.equal(stats.restoredOnBoot.prepSamples, 12, 'ready-gate history restored');

  // The gate must still know this store is fast, not fall back to the prior.
  const predictedAfter = app.engine.gate.predictPrepMinutes('MILNERTON-GALLERIA');
  assert.equal(predictedAfter, predictedBefore, 'prediction identical after restart');
  assert.equal(app.engine.gate.confidence('MILNERTON-GALLERIA'), 'store');

  // The job is still dispatchable, and the driver still exists.
  assert.equal(app.engine.jobs.get(jobId).status, 'PENDING');
  assert.ok(app.engine.supply.get(driverId), 'driver record restored');
  assert.equal(app.engine.supply.get(driverId).zone, 'Milnerton');

  // A restored driver must NOT be online. The app re-announces on reconnect;
  // assuming otherwise means offering jobs to someone who closed the app hours
  // ago, and the offer times out against a phone that will never answer.
  assert.equal(app.engine.supply.get(driverId).state, SUPPLY.OFFLINE,
    'restored drivers come back offline');
  assert.equal(stats.drivers.online, 0);
});

test('a completed delivery leaves durable evidence', async (t) => {
  clean();
  t.after(clean);

  let app = build({ dbPath: DBP });
  const created = await app.inject({ method: 'POST', url: '/v1/keychat/jobs',
    payload: { storeId: 'S1', zone: 'Z', pickup: DBN, dropoff: near(100) } });
  const jobId = created.json().jobId;

  await app.inject({ method: 'POST', url: '/v1/jobs/complete',
    payload: { jobId, grade: 'B', position: near(100),
      gpsTrail: [{ lat: DBN.lat + 0.06, lng: DBN.lng }] } });

  const before = app.engine.db.stats();
  assert.equal(before.evidence, 1);
  shut(app);
  await app.close();

  app = build({ dbPath: DBP });
  t.after(async () => { shut(app); await app.close(); });

  const after = app.engine.db.stats();
  assert.equal(after.evidence, 1, 'evidence survived the restart');
  assert.equal(after.delivered, 1, 'delivered job retained for reporting');
  // Delivered jobs stay on disk but are not reloaded into the working set.
  assert.equal((await app.inject({ url: '/v1/ops/stats' })).json().restoredOnBoot.jobs, 0);
});
