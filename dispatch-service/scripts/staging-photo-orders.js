#!/usr/bin/env node
/**
 * Load a batch of test orders for the photo-check trial, on STAGING only.
 *
 *   STAGING_KEY=hbk_test_... node scripts/staging-photo-orders.js --lat -33.8319 --lng 18.5315
 *   (PowerShell: $env:STAGING_KEY="hbk_test_..."; node dispatch-service/scripts/staging-photo-orders.js --lat ... --lng ...)
 *
 *   --lat --lng  the store, where you stand with the phone (online)
 *   --count      how many orders, 1-8 (default 6)
 *   --url        default https://habibi-staging.quikr.co.za
 *
 * Every order is from store STAGING-TEST (switch its photo check on in the back
 * office, Stores tab) and marked NOSIM, so simulated drivers leave it for your
 * phone. Drop-offs are spread more than 1 km apart so the orders come one at a
 * time rather than stacked.
 *
 * For each order it prints what to put in the photo, including which item to
 * LEAVE OUT on purpose. That is the right answer for the check: mark it
 * "Check was right" or "wrong" on the order in the back office.
 */
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const url = String(opt('url', 'https://habibi-staging.quikr.co.za')).replace(/\/$/, '');
const lat = Number(opt('lat')), lng = Number(opt('lng'));
const count = Math.min(8, Math.max(1, Number(opt('count', 6))));
const key = process.env.STAGING_KEY;
const stop = (m) => { console.error(m); process.exit(1); };

if (!Number.isFinite(lat) || !Number.isFinite(lng)) stop('Give the store, where you will stand: --lat -33.8319 --lng 18.5315');
if (!key) stop('Set STAGING_KEY to the staging partner key (hbk_test_...).');
const host = new URL(url).hostname;
if (!/staging/.test(host) && !['127.0.0.1', 'localhost'].includes(host)) stop(`${url} is not staging. Refusing.`);

// Realistic orders. `leaveOut` is what to keep out of the photo on purpose
// (null: photograph everything). A mix, so the trial tests both answers.
const ORDERS = [
  { items: [{ name: 'Joko tea bags', qty: 1, size: '100s' }, { name: 'Rooibos tea bags', qty: 1, size: '100s' },
    { name: 'Huguenot still water', qty: 1, size: '1.5L' }, { name: 'Hot chocolate', qty: 1, size: '500ml' }],
    leaveOut: 'the hot chocolate' },
  { items: [{ name: 'Streetwise Two', qty: 2 }, { name: 'Large chips', qty: 1 }, { name: 'Coca-Cola', qty: 2, size: '330ml' }],
    leaveOut: null },
  { items: [{ name: 'Albany white bread', qty: 1 }, { name: 'Clover fresh milk', qty: 1, size: '2L' },
    { name: 'Large eggs', qty: 1, size: '6 pack' }, { name: 'Sunlight dishwashing liquid', qty: 1, size: '750ml' }],
    leaveOut: null },
  { items: [{ name: 'Pizza Margherita', qty: 2, size: 'Medium' }, { name: 'Garlic bread', qty: 1 }, { name: 'Sprite', qty: 1, size: '2L' }],
    leaveOut: 'one of the two pizzas' },
  { items: [{ name: 'Simba chips', qty: 3, size: '120g' }, { name: 'Lunch Bar', qty: 2 }, { name: 'Fanta Orange', qty: 1, size: '2L' }],
    leaveOut: null },
  { items: [{ name: 'Coca-Cola', qty: 2, size: '2L' }, { name: 'Bar One', qty: 4 }, { name: 'Doritos', qty: 1, size: '145g' }],
    leaveOut: 'one of the two Coca-Colas' },
  { items: [{ name: 'Panado', qty: 1, size: '24 tablets' }, { name: 'Strepsils', qty: 1, size: '16 lozenges' },
    { name: 'Vicks VapoRub', qty: 1, size: '50g' }],
    leaveOut: null },
  { items: [{ name: 'Burger', qty: 2 }, { name: 'Regular chips', qty: 2 }, { name: 'Milkshake', qty: 1, size: 'Chocolate' }],
    leaveOut: 'the milkshake' },
];

// Drop-offs on a 1.2 km circle around the store, 360/count degrees apart:
// more than 1 km from each other, so no two orders stack into one run.
const dropoff = (i) => {
  const a = (2 * Math.PI * i) / count;
  return { lat: lat + (1200 * Math.cos(a)) / 111320,
    lng: lng + (1200 * Math.sin(a)) / (111320 * Math.cos((lat * Math.PI) / 180)) };
};

const health = await fetch(`${url}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (health && health.env !== 'staging') stop(`${url}/health says env=${health.env}. Refusing.`);

const run = Date.now().toString(36).toUpperCase();
console.log(`Loading ${count} photo-check test orders from STAGING-TEST at ${lat}, ${lng}.\n`);
for (let i = 0; i < count; i++) {
  const o = ORDERS[i];
  const id = `KC-PHOTO-${run}-${i + 1}-NOSIM`;
  const res = await fetch(`${url}/v1/keychat/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'idempotency-key': id },
    body: JSON.stringify({
      externalId: id, storeId: 'STAGING-TEST', zone: 'Staging',
      pickup: { lat, lng, name: 'Staging test store' },
      dropoff: { ...dropoff(i), name: `Photo test customer ${i + 1}` },
      customerCharge: 40, tip: 0, bagCount: 1, prepMinutes: 5, dispatchNow: true,
      items: o.items,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) stop(`Order ${i + 1} refused (${res.status}): ${body.error ?? JSON.stringify(body)}`);
  console.log(`Order ${i + 1}  (job ${body.jobId}, customer ${i + 1})`);
  for (const it of o.items) console.log(`   ${it.qty} x ${it.name}${it.size ? ` ${it.size}` : ''}`);
  console.log(o.leaveOut
    ? `   -> LEAVE OUT of the photo: ${o.leaveOut}. The check should say something is missing.`
    : '   -> Photograph everything. The check should say it matches.');
  console.log('');
}
console.log('The orders come to your phone one at a time. Lay the items out (not in a closed bag) for each photo.');
console.log('Then on each order in the back office: "Check was right" or "Check was wrong". Results: Stores tab.');
