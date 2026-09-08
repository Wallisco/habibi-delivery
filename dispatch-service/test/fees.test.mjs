import test from 'node:test';
import assert from 'node:assert/strict';
import { computeEarnings, costToServe } from '../src/fees.js';
import { RateBook, MRD_DEFAULT } from '../src/rates.js';

const book = new RateBook();
const card = book.forZone('Milnerton');
const job = { id: 'J1', zone: 'Milnerton', bagCount: 1, distanceKm: 3.6 };

test('the card reproduces Mr D\u2019s measured mean leg', () => {
  // Their mean leg: 0.9 km to collection, 3.6 km to the customer, no delay,
  // no premium. Mr D's actual platform-funded mean is R36.11; the residual is
  // their premium (mean R1.95) and delay fee (mean R0.35), neither of which
  // applies to a clean leg.
  const e = computeEarnings(job, card,
    { collectKm: 0.9, deliverKm: 3.6, waitMinutes: 0, premiumMultiplier: 0, tip: 17.27 });
  assert.ok(Math.abs(e.platformFunded - 36.11) < 2.5,
    `expected near R36.11, got R${e.platformFunded}`);
  assert.deepEqual(e.lines.map((l) => l.code),
    ['COLLECTION_BASE', 'COLLECTION_KM', 'DELIVERY_BASE', 'DELIVERY_KM', 'FUEL', 'TIP'],
    'the line set must match Mr D\u2019s payslip exactly');
});

test('distance lines price off the zone card', () => {
  const e = computeEarnings(job, card, { collectKm: 2, deliverKm: 10 });
  assert.equal(e.lines.find((l) => l.code === 'COLLECTION_KM').amount,
    Number((2 * MRD_DEFAULT.perKmCollectionFee).toFixed(2)));
  assert.equal(e.lines.find((l) => l.code === 'DELIVERY_KM').amount,
    Number((10 * MRD_DEFAULT.perKmDeliveryFee).toFixed(2)));
});

test('delay is paid past the free window and capped', () => {
  const none = computeEarnings(job, card, { waitMinutes: 4 });
  assert.equal(none.lines.find((l) => l.code === 'DELAY'), undefined);

  const paid = computeEarnings(job, card, { waitMinutes: 20 });
  assert.equal(paid.lines.find((l) => l.code === 'DELAY').amount,
    Number((15 * MRD_DEFAULT.restaurantDelayPerMinute).toFixed(2)));

  const capped = computeEarnings(job, card, { waitMinutes: 600 });
  assert.equal(capped.lines.find((l) => l.code === 'DELAY').amount,
    MRD_DEFAULT.restaurantDelayCapRands);
});

test('premium scales with the supply shortfall rather than a flat trigger', () => {
  const b = new RateBook();
  assert.equal(b.premiumMultiplier('Z', 2.0), 0, 'well supplied, no premium');
  assert.equal(b.premiumMultiplier('Z', 1.0), 0, 'exactly at threshold, no premium');
  const mild = b.premiumMultiplier('Z', 0.8);
  const severe = b.premiumMultiplier('Z', 0.2);
  assert.ok(severe > mild && mild > 0, 'a worse shortage must pay more');
  assert.ok(severe <= MRD_DEFAULT.premiumMaxMultiplier);

  const e = computeEarnings(job, card, { premiumMultiplier: severe });
  assert.equal(e.lines.find((l) => l.code === 'PREMIUM').amount,
    Number((MRD_DEFAULT.premiumFee * severe).toFixed(2)));
});

test('a zone card overrides the default without touching other zones', () => {
  const b = new RateBook();
  b.setZone('Milnerton', { deliveryBaseFee: 26.00 });
  assert.equal(b.forZone('Milnerton').deliveryBaseFee, 26.00);
  assert.equal(b.forZone('Durbanville').deliveryBaseFee, MRD_DEFAULT.deliveryBaseFee,
    'other zones must be unaffected');
  assert.equal(b.forZone('Milnerton').fuelSurchargePerOrder,
    MRD_DEFAULT.fuelSurchargePerOrder, 'unset fields still inherit');
});

test('unknown or negative rates are rejected rather than silently stored', () => {
  const b = new RateBook();
  b.setZone('Z', { deliveryBaseFee: -5, notARate: 99, fuelSurchargePerOrder: 2.5 });
  assert.equal(b.forZone('Z').deliveryBaseFee, MRD_DEFAULT.deliveryBaseFee, 'negative ignored');
  assert.equal(b.forZone('Z').notARate, undefined, 'unknown key ignored');
  assert.equal(b.forZone('Z').fuelSurchargePerOrder, 2.5, 'valid change applied');
});

test('tips are the customer\u2019s money and never count as platform cost', () => {
  const e = computeEarnings(job, card, { collectKm: 1, deliverKm: 4, tip: 25 });
  assert.equal(e.lines.find((l) => l.code === 'TIP').fundedBy, 'customer');
  assert.equal(e.total, Number((e.platformFunded + 25).toFixed(2)));
  const c = costToServe(e);
  assert.equal(c.driver, e.platformFunded, 'we do not fund the tip');
});

test('the breakdown always sums to the total', () => {
  for (const ctx of [
    { collectKm: 0, deliverKm: 2, waitMinutes: 0, tip: 0, premiumMultiplier: 0 },
    { collectKm: 3.4, deliverKm: 18, waitMinutes: 31, tip: 18, premiumMultiplier: 1.7 },
    { collectKm: 1.1, deliverKm: 6, waitMinutes: 900, tip: 0, premiumMultiplier: 0.4 },
  ]) {
    const e = computeEarnings({ ...job, bagCount: 3 }, card, ctx);
    const summed = e.lines.reduce((a, l) => a + l.amount, 0);
    assert.equal(Number(summed.toFixed(2)), e.total,
      'a driver checking the arithmetic must always get the same answer');
  }
});
