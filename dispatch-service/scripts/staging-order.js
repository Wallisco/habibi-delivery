#!/usr/bin/env node
/**
 * Create a test order on STAGING, to test the driver app with a real phone.
 *
 *   STAGING_KEY=hbk_test_... node scripts/staging-order.js --lat -33.8312 --lng 18.6512 --nosim
 *
 *   --lat --lng  the pickup (stand near it with the phone, online)
 *   --nosim      simulated drivers leave it alone, so your phone gets the offer
 *   --url        default https://habibi-staging.quikr.co.za (or http://127.0.0.1:3001)
 *
 * STAGING_KEY is a staging partner key (scripts/new-partner-key.js keychat-test,
 * hash added to PARTNER_API_KEYS in the staging .env). The drop-off is about
 * 1.5 km north of the pickup. Refuses to run against anything but staging.
 */
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const url = (opt('url') ?? 'https://habibi-staging.quikr.co.za').replace(/\/$/, '');
const lat = Number(opt('lat'));
const lng = Number(opt('lng'));
const key = process.env.STAGING_KEY;

function stop(msg) { console.error(msg); process.exit(1); }

if (!Number.isFinite(lat) || !Number.isFinite(lng)) stop('Give the pickup: --lat -33.8312 --lng 18.6512');
if (!key) stop('Set STAGING_KEY to a staging partner key (hbk_test_...).');
const host = new URL(url).hostname;
if (!/staging/.test(host) && !['127.0.0.1', 'localhost'].includes(host)) {
  stop(`${url} is not staging. This script only creates orders on staging.`);
}

const health = await fetch(`${url}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (health && health.env !== 'staging') stop(`${url}/health says env=${health.env}. Refusing.`);

const nosim = args.includes('--nosim');
const id = `KC-PHONE-${Date.now().toString(36).toUpperCase()}${nosim ? '-NOSIM' : ''}`;
const res = await fetch(`${url}/v1/keychat/jobs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': key, 'idempotency-key': id },
  body: JSON.stringify({
    externalId: id, storeId: 'STAGING-TEST', zone: 'Staging',
    pickup: { lat, lng, name: 'Staging test store' },
    dropoff: { lat: lat + 0.0135, lng, name: 'Staging test customer' },
    customerCharge: 40, tip: 10, bagCount: 1, prepMinutes: 5, dispatchNow: true,
  }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) stop(`Refused (${res.status}): ${body.error ?? JSON.stringify(body)}`);
console.log(`Order ${id} created: job ${body.jobId}${nosim ? ' (left for your phone)' : ''}.`);
console.log('Cancel it from the back office (Orders) or:');
console.log(`  curl -X POST ${url}/v1/ops/orders/${body.jobId}/close -H 'content-type: application/json' --cookie 'ops_sid=...' -d '{"outcome":"CANCELLED","reason":"test"}'`);
