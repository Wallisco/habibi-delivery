import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/server.js';
import { normaliseItems, itemsTotal } from '../src/jobs.js';

const KFC = [
  { name: 'Streetwise burger', qty: 1, unitPrice: 54.9 },
  { name: 'Coke 500ml', qty: 2, unitPrice: 19.9 },
  { name: 'Zinger wings', qty: 1, unitPrice: 49.9, notes: 'Extra hot' },
  { name: 'Burger', qty: 1, unitPrice: 44.9 },
];

test('order lines: cleaned, counted and totalled', () => {
  const lines = normaliseItems([...KFC, { name: '', qty: 1 }, { name: 'Bad qty', qty: 0 }, { name: 'x'.repeat(200), qty: 1 }]);
  assert.equal(lines.length, 5);
  assert.equal(lines[4].name.length, 80);
  assert.equal(itemsTotal(normaliseItems(KFC)), 189.5);
  assert.equal(itemsTotal([{ name: 'a', qty: 1, unitPrice: null }]), null, 'no total when a price is missing');
});

test('items reach the driver without prices, and the back office with them', async (t) => {
  const app = build({ dbPath: ':memory:', partnerAuth: false, opsAuth: false });
  t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/v1/keychat/jobs', payload: {
    externalId: 'KC-KFC-1', storeId: 'KFC-TEST', zone: 'Milnerton', customerCharge: 35,
    pickup: { lat: -33.8318886, lng: 18.531457, name: 'KFC (test)' },
    dropoff: { lat: -33.829, lng: 18.533, name: 'Test drop' }, items: KFC } });
  assert.equal(res.statusCode, 201);
  const { jobId } = res.json();
  const job = app.engine.jobs.get(jobId);
  assert.equal(job.itemCount, 5);
  assert.equal(job.orderValue, 189.5);

  const ops = (await app.inject({ url: `/v1/ops/orders/${jobId}` })).json();
  assert.equal(ops.order.items[1].unitPrice, 19.9);

  // Put a driver near the store and let dispatch offer it.
  const si = (await app.inject({ method: 'POST', url: '/v1/driver/signin', payload: { phone: '0820000009', firstName: 'Test' } })).json();
  app.engine.accounts.get(si.driver.id).onboarding = 'ACTIVE';
  app.engine.supply.upsert(si.driver.id, { state: 'ZONE_COMMITTED', zone: 'Milnerton', position: { lat: -33.8319, lng: 18.5315 } });
  app.engine.jobs.get(jobId).dispatchNow = true;
  app.engine.dispatcher.tick();
  const shift = (await app.inject({ url: `/v1/driver/${si.driver.id}/shift` })).json();
  assert.ok(shift.offer, 'driver got an offer');
  const offered = shift.offer.jobs[0];
  assert.equal(offered.itemCount, 5);
  assert.deepEqual(offered.items.map((i) => `${i.qty}x ${i.name}`), ['1x Streetwise burger', '2x Coke 500ml', '1x Zinger wings', '1x Burger']);
  assert.ok(!JSON.stringify(shift.offer).includes('unitPrice'), 'no prices to the driver');
});
