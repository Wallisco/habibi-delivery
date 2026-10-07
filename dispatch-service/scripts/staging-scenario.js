#!/usr/bin/env node
/**
 * A stacking test for a real phone, on STAGING only.
 *
 *   now     orders A and B: same store (S), customers 20 m apart, about 1.5 km away
 *           -> should be offered to your phone as ONE stacked run
 *   +5 min  orders C and D: two singles from stores about 700 m either side of S,
 *           going different ways -> two separate offers, never stacked together
 *
 * Every order is marked NOSIM, so simulated drivers leave them for your phone.
 *
 *   STAGING_KEY=hbk_test_... node scripts/staging-scenario.js --lat -33.87 --lng 18.51
 *   (PowerShell: $env:STAGING_KEY="hbk_test_..."; node dispatch-service/scripts/staging-scenario.js --lat ... --lng ...)
 *
 *   --lat --lng   store S, where you stand with the phone (online)
 *   --delay 5     minutes before C and D (default 5; 0 sends all four at once)
 *   --url         default https://habibi-staging.quikr.co.za
 *
 * Refuses to run against anything but staging. Keep the window open until it says done.
 */
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const url = String(opt('url', 'https://habibi-staging.quikr.co.za')).replace(/\/$/, '');
const lat = Number(opt('lat')), lng = Number(opt('lng'));
const delayMin = Number(opt('delay', 5));
const key = process.env.STAGING_KEY;
const stop = (m) => { console.error(m); process.exit(1); };

if (!Number.isFinite(lat) || !Number.isFinite(lng)) stop('Give store S, where you will stand: --lat -33.87 --lng 18.51');
if (!Number.isFinite(delayMin) || delayMin < 0) stop('--delay is minutes, e.g. 5');
if (!key) stop('Set STAGING_KEY to the staging partner key (hbk_test_...).');
const host = new URL(url).hostname;
if (!/staging/.test(host) && !['127.0.0.1', 'localhost'].includes(host)) stop(`${url} is not staging. Refusing.`);

// Move a point by metres north and east.
const move = (p, north, east) => ({
  lat: p.lat + north / 111320,
  lng: p.lng + east / (111320 * Math.cos((p.lat * Math.PI) / 180)),
});
const S = { lat, lng };
const C0 = move(S, 0, 700), D0 = move(S, 0, -700);
const run = Date.now().toString(36).toUpperCase();

const ORDERS = {
  A: { store: 'STAGING-STORE-S', pickup: { ...S, name: 'Test store S' }, dropoff: { ...move(S, 1500, 0), name: 'Customer A' } },
  B: { store: 'STAGING-STORE-S', pickup: { ...S, name: 'Test store S' }, dropoff: { ...move(S, 1500, 20), name: 'Customer B (20 m from A)' } },
  C: { store: 'STAGING-STORE-C', pickup: { ...C0, name: 'Test store C' }, dropoff: { ...move(C0, -1200, 300), name: 'Customer C' } },
  D: { store: 'STAGING-STORE-D', pickup: { ...D0, name: 'Test store D' }, dropoff: { ...move(D0, 1200, -300), name: 'Customer D' } },
};

async function create(letter) {
  const o = ORDERS[letter];
  const id = `KC-SCN-${run}-${letter}-NOSIM`;
  const res = await fetch(`${url}/v1/keychat/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'idempotency-key': id },
    body: JSON.stringify({
      externalId: id, storeId: o.store, zone: 'Staging',
      pickup: o.pickup, dropoff: o.dropoff,
      customerCharge: 35, tip: 0, bagCount: 1, prepMinutes: 5, dispatchNow: true,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) stop(`Order ${letter} refused (${res.status}): ${body.error ?? JSON.stringify(body)}`);
  console.log(`  ${letter}: job ${body.jobId}  (${o.pickup.name} -> ${o.dropoff.name})`);
  return body.jobId;
}

const health = await fetch(`${url}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (!health) stop(`${url}/health did not answer.`);
if (health.env !== 'staging') stop(`${url}/health says env=${health.env}. Refusing.`);

console.log(`Store S: ${lat.toFixed(5)}, ${lng.toFixed(5)}. Be online on the phone near it.`);
console.log('Now: the stackable pair, same store, customers 20 m apart');
await create('A');
await create('B');
if (delayMin > 0) {
  console.log(`Waiting ${delayMin} min for the two singles. Keep this window open.`);
  await new Promise((r) => setTimeout(r, delayMin * 60000));
}
console.log('Now: two singles from nearby stores');
await create('C');
await create('D');
console.log('Done. Expect: one offer with A+B stacked; then C and D as separate offers.');
console.log('Cancel any of them from the staging back office (Orders) to test recovery.');
