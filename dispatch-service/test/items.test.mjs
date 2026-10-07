// What is in an order (KEYCHAT_API.md v1.2): validated at intake, kept on the
// job, and shown to the driver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/server.js';
import { parseItems, itemLine } from '../src/items.js';

const ORDER = { storeId: 'KFC-MIL', zone: 'Milnerton',
  pickup: { lat: -33.8312, lng: 18.6512, name: 'KFC Milnerton' },
  dropoff: { lat: -33.8401, lng: 18.6588, name: '14 Pienaar Road, Milnerton' } };
const ITEMS = [{ name: 'Pizza Margherita', qty: 3 }, { name: 'Coke', qty: 1, size: '500ml' }, { name: 'Sprite', size: '500ml' }];

function appFor(t) {
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false, driverAuth: false });
  t.after(() => app.close());
  return app;
}
const create = (app, extra) => app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: { ...ORDER, ...extra } });

test('items are checked: product lines only, sensible sizes', () => {
  assert.deepEqual(parseItems(undefined), { items: null });
  assert.deepEqual(parseItems([]), { items: null });
  assert.deepEqual(parseItems([{ name: '  Coke  ', qty: 2, size: ' 500ml ' }]).items, [{ name: 'Coke', qty: 2, size: '500ml' }]);
  assert.deepEqual(parseItems([{ name: 'Bread' }]).items, [{ name: 'Bread', qty: 1 }], 'qty defaults to 1');
  assert.match(parseItems('3 pizzas').error, /must be a list/);
  assert.match(parseItems([{ qty: 1 }]).error, /items\[0\]\.name is required/);
  assert.match(parseItems([{ name: 'Coke', qty: 0 }]).error, /qty must be a whole number from 1 to 99/);
  assert.match(parseItems([{ name: 'Coke', qty: 1.5 }]).error, /whole number/);
  assert.match(parseItems([{ name: 'x'.repeat(61) }]).error, /longer than 60/);
  assert.match(parseItems([{ name: 'Coke', size: 'y'.repeat(21) }]).error, /size is longer than 20/);
  assert.match(parseItems(Array.from({ length: 51 }, () => ({ name: 'Coke' }))).error, /at most 50/);
  assert.equal(itemLine({ name: 'Coke', qty: 1, size: '500ml' }), '1 × Coke 500ml');
});

test('an order with items keeps them, counts them, and shows them to the driver', async (t) => {
  const app = appFor(t);
  const res = await create(app, { items: ITEMS, dispatchNow: true });
  assert.equal(res.statusCode, 201);
  const job = app.engine.jobs.get(res.json().jobId);
  assert.deepEqual(job.items, [{ name: 'Pizza Margherita', qty: 3 }, { name: 'Coke', qty: 1, size: '500ml' }, { name: 'Sprite', qty: 1, size: '500ml' }]);
  assert.equal(job.itemCount, 5);

  // The driver gets them with the offer and on the run.
  const s = (await app.inject({ method: 'POST', url: '/v1/driver/signin', payload: { phone: '0821234567' } })).json();
  const id = s.driver.id;
  for (const d of (await app.inject({ url: `/v1/driver/${id}/account` })).json().requiredDocs) {
    await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/document`, payload: { docKey: d.key, status: 'VERIFIED' } });
  }
  await app.inject({ method: 'PATCH', url: `/v1/ops/accounts/${id}`, payload: { vehicleReg: 'CA 1', zone: 'Milnerton' } });
  await app.inject({ method: 'POST', url: `/v1/ops/accounts/${id}/onboarding`, payload: { state: 'ACTIVE' } });
  await app.inject({ method: 'POST', url: `/v1/driver/${id}/state`, payload: { state: 'ZONE_COMMITTED', zone: 'Milnerton' } });
  await app.inject({ method: 'POST', url: `/v1/driver/${id}/position`, payload: { lat: ORDER.pickup.lat, lng: ORDER.pickup.lng } });
  app.engine.dispatcher.tick();
  const offer = (await app.inject({ url: `/v1/driver/${id}/shift` })).json().offer;
  assert.equal(offer.job.itemCount, 5);
  assert.equal(offer.job.items.length, 3);

  // And the back office sees them on the order.
  const detail = (await app.inject({ url: `/v1/ops/orders/${job.id}` })).json();
  assert.equal(detail.order.items.length, 3);
});

test('an order without items still works, as before', async (t) => {
  const app = appFor(t);
  const res = await create(app, { itemCount: 4 });
  assert.equal(res.statusCode, 201);
  const job = app.engine.jobs.get(res.json().jobId);
  assert.equal(job.items, null);
  assert.equal(job.itemCount, 4);
});

test('a bad item list is refused with the reason', async (t) => {
  const app = appFor(t);
  const res = await create(app, { items: [{ name: 'Coke', qty: 0 }] });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /qty/);
});

test('an age-restricted order is kept as such, so the driver is warned', async (t) => {
  const app = appFor(t);
  const job = app.engine.jobs.get((await create(app, { ageRestricted: true })).json().jobId);
  assert.equal(job.ageRestricted, true);
  assert.equal(job.proofPolicy.minGrade, 'B');
});
