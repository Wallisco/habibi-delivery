// The AI check of the collection photo (a trial, switched on per store).
// A fake client stands in for the Claude API: tests never call it or spend money.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/server.js';
import { SUPPLY } from '../src/supply.js';
import { createPhotoChecker, checkCost, PHOTO_CHECK_MODEL } from '../src/photoCheck.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1500, 3)]);
const ITEMS = [{ name: 'Pizza Margherita', qty: 3 }, { name: 'Sprite', qty: 1, size: '500ml' }];

/** A stand-in for the Anthropic client: answers with `answer`, records the request. */
function fakeClient(answer, { usage = { input_tokens: 1800, output_tokens: 120 }, stop = 'end_turn', fail = null, gate = null } = {}) {
  const calls = [];
  return {
    calls,
    beta: { messages: { parse: async (params) => {
      calls.push(params);
      if (gate) await gate;   // hold the answer, like a model that takes a few seconds
      if (fail) throw fail;
      return { model: PHOTO_CHECK_MODEL, stop_reason: stop, usage, parsed_output: answer };
    } } },
  };
}
const answer = (verdict, missing = [], seen = []) => ({ verdict, missing, seen, note: 'One Sprite is not in the photo.' });

/* ----------------------------------------------------------- the check */

test('the check sends the photo and the item list, and records model, effort, time and tokens', async () => {
  const client = fakeClient(answer('missing', [{ name: 'Sprite', qty: 1 }], [{ name: 'Pizza Margherita', qty: 3 }]));
  const r = await createPhotoChecker({ client, effort: 'low' }).check({ jpeg: JPEG, items: ITEMS, bagCount: 2 });
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.missing, [{ name: 'Sprite', qty: 1 }]);
  assert.equal(r.model, PHOTO_CHECK_MODEL);
  assert.equal(r.effort, 'low');
  assert.deepEqual(r.usage, { input: 1800, output: 120 });
  assert.ok(r.ms >= 0);

  const req = client.calls[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.output_config.effort, 'low');
  assert.ok(req.output_config.format, 'structured output');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  const [img, text] = req.messages[0].content;
  assert.equal(img.type, 'image');
  assert.equal(img.source.media_type, 'image/jpeg');
  assert.equal(img.source.data, JPEG.toString('base64'));
  assert.match(text.text, /- 3 x Pizza Margherita/);
  assert.match(text.text, /- 1 x Sprite \(500ml\)/);
  assert.match(text.text, /Packed in 2 bags/);
});

test('the verdict is kept consistent with its own lists', async () => {
  const saysCompleteButMissing = fakeClient(answer('complete', [{ name: 'Sprite', qty: 1 }]));
  assert.equal((await createPhotoChecker({ client: saysCompleteButMissing }).check({ jpeg: JPEG, items: ITEMS })).status, 'missing');
  const saysMissingButNothing = fakeClient(answer('missing', []));
  assert.equal((await createPhotoChecker({ client: saysMissingButNothing }).check({ jpeg: JPEG, items: ITEMS })).status, 'unclear');
});

test('no key, a refusal or an API error never throws: the check says so', async () => {
  assert.equal((await createPhotoChecker({ apiKey: '' }).check({ jpeg: JPEG, items: ITEMS })).status, 'not_configured');
  const declined = await createPhotoChecker({ client: fakeClient(null, { stop: 'refusal' }) }).check({ jpeg: JPEG, items: ITEMS });
  assert.deepEqual([declined.status, declined.reason], ['error', 'declined']);
  const failed = await createPhotoChecker({ client: fakeClient(null, { fail: Object.assign(new Error('overloaded'), { status: 529 }) }) })
    .check({ jpeg: JPEG, items: ITEMS });
  assert.deepEqual([failed.status, failed.reason], ['error', '529']);
});

test('cost is worked out from the tokens at $4 / $20 per million', () => {
  assert.equal(checkCost({ input: 1_000_000, output: 0 }), 4);
  assert.equal(checkCost({ input: 0, output: 1_000_000 }), 20);
  assert.equal(Number(checkCost({ input: 1800, output: 120 }).toFixed(4)), 0.0096);
});

/* ------------------------------------------------ the flow on staging */

function appFor(t, client) {
  const photoDir = mkdtempSync(join(tmpdir(), 'dispatch-photocheck-'));
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false, photoDir,
    photoChecker: createPhotoChecker({ client, effort: 'low' }) });
  t.after(() => app.close());
  return app;
}

async function driverWithOrder(app, { storeId = 'KFC-MIL', items = ITEMS, phone = '0821111111' } = {}) {
  const STORE = { lat: -33.8312, lng: 18.6512, name: 'KFC Milnerton' };
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
    storeId, zone: 'Milnerton', pickup: STORE, dropoff: { lat: STORE.lat + 0.01, lng: STORE.lng, name: 'Home' },
    dispatchNow: true, items } })).json().jobId;
  app.engine.dispatcher.tick();
  const accepted = (await app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/accept`, payload: { driverId: id } })).json();
  return { id, headers, jobId, accepted };
}
const upload = (app, d) => app.inject({ method: 'POST', url: `/v1/driver/collection-photo?jobs=${d.jobId}`,
  headers: { ...d.headers, 'content-type': 'image/jpeg' }, payload: JPEG });
const checkFor = async (app, d) => (await app.inject({ url: `/v1/driver/photo-check?jobs=${d.jobId}`, headers: d.headers })).json().checks[d.jobId];

test('every store starts with the check off: the photo uploads and nothing is checked', async (t) => {
  const client = fakeClient(answer('complete'));
  const app = appFor(t, client);
  const d = await driverWithOrder(app);
  assert.equal(d.accepted.job.photoCheck, false, 'the app is told the check is off');
  assert.equal((await upload(app, d)).statusCode, 200);
  await app.engine.photoChecksDone();
  assert.equal(client.calls.length, 0);
  assert.equal(await checkFor(app, d), null);
});

test('switched on for the store: the photo is checked in the background and the driver gets the result', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const client = fakeClient(answer('missing', [{ name: 'Sprite', qty: 1 }]), { gate });
  const app = appFor(t, client);
  const sw = await app.inject({ method: 'PUT', url: '/v1/ops/stores/KFC-MIL', payload: { photoCheck: true } });
  assert.equal(sw.statusCode, 200);
  const d = await driverWithOrder(app);
  assert.equal(d.accepted.job.photoCheck, true, 'the app knows to wait for a result');

  assert.equal((await upload(app, d)).statusCode, 200, 'the upload does not wait for the check');
  assert.equal((await checkFor(app, d)).status, 'pending');
  release();
  await app.engine.photoChecksDone();
  const c = await checkFor(app, d);
  assert.deepEqual(c, { status: 'missing', missing: [{ name: 'Sprite', qty: 1 }], note: 'One Sprite is not in the photo.' });
  assert.equal(client.calls.length, 1);

  // Another driver can't read it.
  const other = await driverWithOrder(app, { phone: '0822222222' });
  const res = await app.inject({ url: `/v1/driver/photo-check?jobs=${d.jobId}`, headers: other.headers });
  assert.equal(res.statusCode, 403);
  assert.equal((await app.inject({ url: `/v1/driver/photo-check?jobs=${d.jobId}` })).statusCode, 401);
});

test('an order without an item list is not checked, even in a trial store', async (t) => {
  const client = fakeClient(answer('complete'));
  const app = appFor(t, client);
  await app.inject({ method: 'PUT', url: '/v1/ops/stores/KFC-MIL', payload: { photoCheck: true } });
  const d = await driverWithOrder(app, { items: null });
  await upload(app, d);
  await app.engine.photoChecksDone();
  assert.equal(client.calls.length, 0);
});

test('the office reviews each check, and the trial report counts accuracy, speed and cost', async (t) => {
  const client = fakeClient(answer('complete'));
  const app = appFor(t, client);
  await app.inject({ method: 'PUT', url: '/v1/ops/stores/KFC-MIL', payload: { photoCheck: true } });
  const d = await driverWithOrder(app);
  await upload(app, d);
  await app.engine.photoChecksDone();

  assert.equal((await app.inject({ method: 'POST', url: `/v1/ops/orders/${d.jobId}/photo-check/review`, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/ops/orders/${d.jobId}/photo-check/review`, payload: { correct: true } })).statusCode, 200);

  const report = (await app.inject({ url: '/v1/ops/photo-checks' })).json();
  assert.equal(report.overall.checks, 1);
  assert.equal(report.overall.complete, 1);
  assert.equal(report.overall.reviewed, 1);
  assert.equal(report.overall.accuracy, 1);
  assert.equal(report.overall.costPerCheckUsd, 0.0096);
  assert.deepEqual(report.stores.map((s) => s.storeId), ['KFC-MIL']);

  const storesList = (await app.inject({ url: '/v1/ops/stores' })).json();
  const kfc = storesList.stores.find((s) => s.storeId === 'KFC-MIL');
  assert.equal(kfc.photoCheck, true);
  assert.equal(kfc.photoChecks.checks, 1);
  assert.equal(storesList.checkConfigured, true);
});

test('only ops and admin can switch a store; anyone signed in can see the list', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false, photoChecker: createPhotoChecker({ apiKey: '' }) });
  t.after(() => app.close());
  app.engine.opsUsers.add({ email: 'v@x.co', name: 'Viewer', role: 'viewer', password: 'long-enough-1' });
  app.engine.opsUsers.add({ email: 'o@x.co', name: 'Ops', role: 'ops', password: 'long-enough-1' });
  const cookie = async (email) => (await app.inject({ method: 'POST', url: '/v1/ops/login',
    payload: { email, password: 'long-enough-1' } })).headers['set-cookie'].split(';')[0];
  const put = (c) => app.inject({ method: 'PUT', url: '/v1/ops/stores/KFC-MIL', payload: { photoCheck: true }, headers: { cookie: c } });
  assert.equal((await put(await cookie('v@x.co'))).statusCode, 403);
  assert.equal((await put(await cookie('o@x.co'))).statusCode, 200);
  assert.equal(app.engine.stores.photoCheck('KFC-MIL'), true);
  const list = await app.inject({ url: '/v1/ops/stores', headers: { cookie: await cookie('v@x.co') } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().checkConfigured, false, 'no API key: the office sees it is not configured');
});
