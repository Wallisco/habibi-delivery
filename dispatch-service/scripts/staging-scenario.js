#!/usr/bin/env node
/**
 * A stacking test for a real phone, on STAGING only.
 *
 *   now     orders A and B: same store (S), customers 20 m apart, 450 m north
 *           -> should be offered to your phone as ONE stacked run
 *   +5 min  orders C and D: two singles from stores 225 m either side of S,
 *           going different ways -> two separate offers, never stacked together
 *
 * Everything sits within 450 m of S, so a whole run takes minutes. The drop-offs are
 * placed more than 500 m apart where they must not stack (the stacking limit).
 *
 * Every order is marked NOSIM, so simulated drivers leave them for your phone.
 *
 *   STAGING_KEY=hbk_test_... node scripts/staging-scenario.js --lat -33.87 --lng 18.51
 *   (PowerShell: $env:STAGING_KEY="hbk_test_..."; node dispatch-service/scripts/staging-scenario.js --lat ... --lng ...)
 *
 *   --preset killarney   real places in Killarney Gardens, Cape Town (no --lat/--lng needed):
 *                 A+B  Oli's Foods -> Slice Shack and POLAR Ice Cream, Marina Park (13 m apart)
 *                 C    Brother Bill's Take-Aways -> Carbon Technique, Blaauwberg Business Park
 *                 D    FreshStop Killarney -> Blaauwberg Business Park gate, Potsdam Rd
 *   --lat --lng   otherwise: store S, where you stand with the phone (online)
 *   --delay 5     minutes before C and D (default 5; 0 sends all four at once)
 *   --url         default https://habibi-staging.quikr.co.za
 *
 * Refuses to run against anything but staging. Keep the window open until it says done.
 */
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const url = String(opt('url', 'https://habibi-staging.quikr.co.za')).replace(/\/$/, '');
const preset = opt('preset');
const lat = Number(opt('lat')), lng = Number(opt('lng'));
const delayMin = Number(opt('delay', 5));
const key = process.env.STAGING_KEY;
const stop = (m) => { console.error(m); process.exit(1); };

if (preset && preset !== 'killarney') stop('Unknown --preset. Use: killarney');
if (!preset && (!Number.isFinite(lat) || !Number.isFinite(lng))) stop('Give store S, where you will stand: --lat -33.87 --lng 18.51, or --preset killarney');
if (!Number.isFinite(delayMin) || delayMin < 0) stop('--delay is minutes, e.g. 5');
if (!key) stop('Set STAGING_KEY to the staging partner key (hbk_test_...).');
const host = new URL(url).hostname;
if (!/staging/.test(host) && !['127.0.0.1', 'localhost'].includes(host)) stop(`${url} is not staging. Refusing.`);

// Move a point by metres north and east.
const move = (p, north, east) => ({
  lat: p.lat + north / 111320,
  lng: p.lng + east / (111320 * Math.cos((p.lat * Math.PI) / 180)),
});
const S = preset ? { lat: -33.828439, lng: 18.533136 } : { lat, lng };
const C0 = move(S, 0, 225), D0 = move(S, 0, -225);
const run = Date.now().toString(36).toUpperCase();

// Real places, Killarney Gardens (Google Maps positions, 7 Oct 2026). Every trip is under 450 m;
// C and D go south-west, more than 500 m from Marina Park, so they can't stack with A+B or each other.
const KILLARNEY = {
  A: { store: 'STAGING-OLIS', pickup: { lat: -33.828439, lng: 18.533136, name: "Oli's Foods, 26 Killarney Ave" }, dropoff: { lat: -33.826778, lng: 18.534634, name: 'Slice Shack, Unit 3 Marina Park, 27 Silverstone Rd' } },
  B: { store: 'STAGING-OLIS', pickup: { lat: -33.828439, lng: 18.533136, name: "Oli's Foods, 26 Killarney Ave" }, dropoff: { lat: -33.826891, lng: 18.534585, name: 'POLAR Ice Cream, Unit 6 Marina Park, 27 Silverstone Rd' } },
  C: { store: 'STAGING-BROTHER-BILLS', pickup: { lat: -33.830563, lng: 18.534126, name: "Brother Bill's Take-Aways, 2 Le Mans Cl" }, dropoff: { lat: -33.831826, lng: 18.529581, name: 'Carbon Technique, Unit 7 Blaauwberg Business Park' } },
  D: { store: 'STAGING-FRESHSTOP', pickup: { lat: -33.835705, lng: 18.526027, name: 'FreshStop Killarney, Koeberg Rd' }, dropoff: { lat: -33.833092, lng: 18.527463, name: 'Blaauwberg Business Park gate, Potsdam Rd' } },
};

const GENERATED = {
  A: { store: 'STAGING-STORE-S', pickup: { ...S, name: 'Test store S' }, dropoff: { ...move(S, 450, 0), name: 'Customer A' } },
  B: { store: 'STAGING-STORE-S', pickup: { ...S, name: 'Test store S' }, dropoff: { ...move(S, 450, 20), name: 'Customer B (20 m from A)' } },
  C: { store: 'STAGING-STORE-C', pickup: { ...C0, name: 'Test store C' }, dropoff: { ...move(S, -380, 200), name: 'Customer C' } },
  D: { store: 'STAGING-STORE-D', pickup: { ...D0, name: 'Test store D' }, dropoff: { ...move(S, 0, -450), name: 'Customer D' } },
};
const ORDERS = preset ? KILLARNEY : GENERATED;

// What is in each order, so the driver's store checklist has something to show.
const ITEMS = {
  A: [{ name: 'Pizza Margherita', qty: 3 }, { name: 'Coke', qty: 1, size: '500ml' }, { name: 'Sprite', qty: 1, size: '500ml' }],
  B: [{ name: 'Chicken burger meal', qty: 2 }, { name: 'Fanta', qty: 2, size: '330ml' }],
  C: [{ name: 'Boerewors roll', qty: 1 }, { name: 'Chips', qty: 1, size: 'Large' }],
  D: [{ name: 'Milk', qty: 1, size: '2L' }, { name: 'Bread', qty: 1 }, { name: 'Eggs', qty: 1, size: '6 pack' }],
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
      items: ITEMS[letter],
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

console.log(preset ? "Preset killarney: stand near Oli's Foods, 26 Killarney Ave, online on the phone." : `Store S: ${lat.toFixed(5)}, ${lng.toFixed(5)}. Be online on the phone near it.`);
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
