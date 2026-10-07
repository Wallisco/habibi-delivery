// Collection photos: the driver's photo of the order at the store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/server.js';
import { SUPPLY } from '../src/supply.js';

const STORE = { lat: -33.8312, lng: 18.6512, name: 'KFC Milnerton' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);

function appFor(t, extra = {}) {
  const photoDir = mkdtempSync(join(tmpdir(), 'dispatch-photos-test-'));
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false, photoDir, ...extra });
  t.after(() => app.close());
  return { app, photoDir };
}

async function driverWithJob(app, phone = '0821111111') {
  const s = (await app.inject({ method: 'POST', url: '/v1/driver/signin', payload: { phone } })).json();
  const id = s.driver.id;
  const headers = { authorization: `Bearer ${s.token}` };
  for (const d of (await app.inject({ url: `/v1/driver/${id}/account`, headers })).json().requiredDocs) {
    await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/document`, payload: { docKey: d.key, status: 'VERIFIED' } });
  }
  await app.inject({ method: 'PATCH', url: `/v1/ops/accounts/${id}`, payload: { vehicleReg: 'CA 1', zone: 'Milnerton' } });
  await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/onboarding`, payload: { state: 'ACTIVE' } });
  await app.inject({ method: 'POST', url: `/v1/driver/${id}/state`, payload: { state: SUPPLY.ZONE_COMMITTED, zone: 'Milnerton' }, headers });
  await app.inject({ method: 'POST', url: `/v1/driver/${id}/position`, payload: { lat: STORE.lat, lng: STORE.lng }, headers });
  const jobId = (await app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: {
    storeId: 'KFC-MIL', zone: 'Milnerton', pickup: STORE,
    dropoff: { lat: STORE.lat + 0.01, lng: STORE.lng, name: 'Home' }, dispatchNow: true } })).json().jobId;
  app.engine.dispatcher.tick();
  await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/accept`, payload: { driverId: id } });
  return { id, headers, jobId };
}

const upload = (app, jobIds, headers, body = JPEG, type = 'image/jpeg') => app.inject({
  method: 'POST', url: `/v1/driver/collection-photo?jobs=${jobIds.join(',')}`,
  headers: { ...headers, 'content-type': type }, payload: body });

test('the driver uploads a photo of their order; the back office can see it', async (t) => {
  const { app, photoDir } = appFor(t);
  const d = await driverWithJob(app);
  const res = await upload(app, [d.jobId], d.headers);
  assert.equal(res.statusCode, 200, res.body);
  const photo = app.engine.jobs.get(d.jobId).collectionPhoto;
  assert.equal(photo.bytes, JPEG.length);
  assert.equal(photo.driverId, d.id);
  assert.deepEqual(readdirSync(photoDir), [photo.file], 'one file on disk, named by the server');

  const view = await app.inject({ url: `/v1/ops/orders/${d.jobId}/collection-photo` });
  assert.equal(view.statusCode, 200);
  assert.equal(view.headers['content-type'], 'image/jpeg');
  assert.ok(view.rawPayload.equals(JPEG));
  assert.equal((await app.inject({ url: `/v1/ops/orders/${d.jobId}` })).json().order.collectionPhoto.file, photo.file);
});

test('only the driver carrying the order can upload, only a JPEG, at most 3 MB', async (t) => {
  const { app } = appFor(t);
  const me = await driverWithJob(app, '0821111111');
  const other = await driverWithJob(app, '0822222222');

  assert.equal((await upload(app, [me.jobId], {})).statusCode, 401, 'no token');
  assert.equal((await upload(app, [other.jobId], me.headers)).statusCode, 403, "someone else's order");
  assert.equal((await upload(app, ['JOB-nope'], me.headers)).statusCode, 404);
  assert.equal((await upload(app, [], me.headers)).statusCode, 400, 'no order named');
  assert.equal((await upload(app, [me.jobId], me.headers, Buffer.from('not a photo'))).statusCode, 415);
  assert.equal((await upload(app, [me.jobId], me.headers, Buffer.from('{}'), 'application/json')).statusCode, 415);
  const big = Buffer.concat([JPEG, Buffer.alloc(3 * 1024 * 1024)]);
  assert.equal((await upload(app, [me.jobId], me.headers, big)).statusCode, 413);
  assert.equal(app.engine.jobs.get(me.jobId).collectionPhoto, undefined);
});

test('photos are deleted after 30 days and the order says so', async (t) => {
  const { app, photoDir } = appFor(t);
  const d = await driverWithJob(app);
  await upload(app, [d.jobId], d.headers);
  const { file } = app.engine.jobs.get(d.jobId).collectionPhoto;

  assert.equal(app.engine.sweepPhotos(), 0, 'a fresh photo stays');
  const old = new Date(Date.now() - 31 * 86400 * 1000);
  utimesSync(join(photoDir, file), old, old);
  assert.equal(app.engine.sweepPhotos(), 1);
  assert.deepEqual(readdirSync(photoDir), []);
  assert.ok(app.engine.jobs.get(d.jobId).collectionPhoto.deletedAt);
  assert.equal((await app.inject({ url: `/v1/ops/orders/${d.jobId}/collection-photo` })).statusCode, 404);
});

test('a photo can only be read by its own file name', async (t) => {
  const { app } = appFor(t);
  assert.equal(app.engine.photos.read('../../etc/passwd'), null);
  assert.equal(app.engine.photos.read(''), null);
});
