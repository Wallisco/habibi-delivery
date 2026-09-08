# Dispatch service

The engine behind the driver app. Takes orders from Keychat, decides when to
release each one and to whom, and closes it with verified proof of delivery.

This is the piece the whole thesis rests on. The ready gate is what turns a
driver's 9 orders a shift into 11.6, and everything in the investor deck about
driver economics follows from it working.

```bash
npm install
npm start          # http://localhost:3000
npm test           # 14 tests, including restart survival
```

State persists to SQLite via Node's built-in `node:sqlite` — no install, no
service, one file at `./data/dispatch.db`. Stop and restart the service and
drivers, open jobs, delivery evidence and ready-gate history all come back.

Driver **positions** are deliberately not persisted. They change every few
seconds and run at roughly 500 writes/sec at 10% national share, against 27,400
order events a day; durable storage would need to be ten times the size for no
benefit. They live in memory here and belong in Redis in production. Only the
GPS trail of a completed delivery is written, as one row, as evidence.

Set `DB_PATH` to move the database file, or `:memory:` to run without one.
`npm run reset` clears it.

## The back office

`http://localhost:3000/ops` — served by this process, nothing extra to deploy.

| Tab | What it is for |
|---|---|
| Overview | KPIs, hourly demand, merchant leaderboard, exception queue |
| Orders | Every order with its state; click one for a full timeline and the customer tracking link |
| Drivers | Onboarding queue, document verification, activation, per-driver history |
| Earnings | Per-driver pay and the Keychat reconciliation statement |
| Messages | Two-way chat with drivers, with quick replies |
| Pricing | Rate cards and surge schedule, per zone |
| Integration | Routing mode and the Keychat webhook queue |

`http://localhost:3000/track/:jobId` is the customer's live tracking page. The
link is emitted to Keychat on `delivery.code_issued` so they can put it in the
WhatsApp thread. It shows the driver's first name and vehicle only — never a
surname, phone number or location history.

## What is here

| File | Does |
|---|---|
| `src/readyGate.js` | Predicts when food will be ready. Rolling per-store median, censoring-aware. |
| `src/dispatch.js` | Batching window, cost function, offer cascade. |
| `src/supply.js` | Driver registry, geo maths, supply ratio, roaming premium. |
| `src/jobs.js` | Job lifecycle and the canonical job shape. |
| `src/otp.js` | Delivery codes: issue, geofence-verify, attempt caps. |
| `src/server.js` | HTTP API for the driver app and Keychat. |
| `src/db.js` | SQLite persistence. The only file that touches SQL. |
| `src/accounts.js` | Driver accounts, onboarding state machine, document verification. |
| `src/orders.js` | Order state list, per-order timeline, ops-driver messaging. |
| `src/rates.js` | Per-zone rate cards and the surge schedule. |
| `src/fees.js` | Itemised driver pay, mirroring Mr D's payslip lines. |
| `src/routing.js` | OSRM with a straight-line fallback. |
| `src/keychat.js` | Outbound webhooks and the reconciliation statement. |
| `src/metrics.js` | Productivity, quality, speed and cost-to-serve reporting. |

## API

### Keychat

```
POST /v1/keychat/quote            price + ETA before checkout, synchronous
POST /v1/keychat/jobs             create a delivery job
POST /v1/keychat/jobs/:id/ready   POS label-print event  ← the ready signal
GET  /v1/keychat/events           status events owed back to Keychat
```

`/ready` is the important one. When the merchant's POS prints the bag label, that
timestamp is when the food was actually ready — and it is **uncensored**, unlike
the driver's collection scan. Neither Uber Eats nor Mr D collect it. Without this
endpoint being called, the ready gate falls back to learning from collection
scans, which is materially worse (see the censoring note in `readyGate.js`).

### Driver app

```
POST /v1/driver/signin
POST /v1/driver/:id/state         supply state machine transitions
POST /v1/driver/:id/position      location ping
GET  /v1/driver/:id/shift         state, supply ratio, roaming premium, any live offer
GET  /v1/driver/:id/earnings
POST /v1/jobs/:id/accept | /decline
POST /v1/jobs/:id/collect         driver's collection scan
POST /v1/jobs/:id/approach        issues the customer's code
POST /v1/jobs/:id/verify          code + driver position
POST /v1/jobs/complete            evidence bundle
```

Endpoints match `driver-app/src/lib/api.js` exactly. Set the app's
`extra.demoMode` to `false` and `extra.apiBaseUrl` to this service and the two
halves work together.

## Decisions worth knowing about

**The gate holds jobs back.** A job is not offered when it is placed; it becomes
eligible at *(predicted ready) − (travel to store) − buffer*. That single rule
does more for driver utilisation than any matching cleverness.

**Urgency comes from slack, never from vertical.** `slack = promiseAt − now −
estimated duration`. Food naturally wins early because it has minutes of slack
while a parcel has hours; as the parcel ages its slack collapses and it starts
outranking fresh food orders on its own. That is anti-starvation for free — no
priority table to maintain.

**Displacement is a cost term, not a rule.** A roaming job removes a driver from
their zone. That costs nothing at 14:00 in a well-supplied zone and a great deal
at 17:30. Priced in `displacementCost()`, so long runs are refused at dinner
because the arithmetic says so, not because someone wrote an if-statement. The
boundary then moves with actual supply.

**No routing API in the hot path.** Scoring every dispatch candidate through
Google Directions would cost roughly R750k a month at 10% national share.
Straight-line distance times a learned urban speed factor ranks candidates
accurately enough, which is all the cost function needs.

**The code never reaches the driver.** `/approach` issues it and emits it toward
Keychat for delivery to the customer. It appears in no driver-facing response.
Verification is server-side and rejects entry outside the geofence — without
that, a driver can phone ahead, collect the code, and abandon the order.

**Offline completions are re-verified.** A grade B completion holds payout until
it syncs; if its GPS trail never entered the geofence, it is flagged.

## Two bugs the tests caught

Worth recording, because both would have been ugly in production.

1. **Declined jobs were re-offered to the same driver.** The `tried` set lived on
   the offer record, which was deleted on decline — so the next tick had no
   memory and offered the same job to the same driver, forever. Declines now
   persist per job in `declinedBy`.
2. **Queue depth read zero under load.** `queueDepth` used a strict `t < at`,
   which dropped orders placed in the same millisecond as the read — exactly
   when a kitchen is busiest.

## Moving to Postgres

Every statement in `src/db.js` is plain SQL and nothing outside that file
touches the database. Swap `DatabaseSync` for a pg pool, change `?` placeholders
to `$1`, and `INTEGER PRIMARY KEY` to `BIGSERIAL`. SQLite is right while one
machine serves a zone; move when more than one process needs to write.

If you ever migrate selectively, keep `prep_samples` above everything else. It
is the ready gate's training data and the one asset neither incumbent collects.

## Conventions

IDs follow the Mr D exports, so anyone who has worked an incumbent back office
reads ours without retraining:

| | Format | Example |
|---|---|---|
| Driver ID | 6-digit numeric | `129105`, `134845` |
| Hub code | 3 letters | `TYG`, `MIL`, `CBD` |
| Order number | vertical prefix + 9 digits | `DFD323345084`, `GROC...` |
| Shift slot | | `16:00-22:00`, `11:00-16:00`, `Before 11:00` |
| Vehicle type | | Motorbike, Car, Bicycle, Van |

## Onboarding

A driver cannot receive a job until every document is verified and a vehicle is
registered. That is enforced server-side, not just in the console: going online
returns 403 with the outstanding items, and the app shows a checklist instead of
a Go online button.

`REGISTERED → DOCS_SUBMITTED → DOCS_VERIFIED → VEHICLE_ASSIGNED → ACTIVE`

Making it a sequence rather than a boolean is what stops an unvetted person
carrying someone's dinner, and it gives ops a queue to work rather than a
spreadsheet.

## Not built yet

- **Auth.** `signin` returns a fake token and nothing verifies it.
- **Push.** Offers sit in `/shift` for the app to poll. Production needs
  FCM/APNs so an offer wakes the device.
- **Zone sharding.** One dispatcher instance serves everything. Fine to well past
  a metro; shard by zone for fault isolation rather than throughput.
- **Batching.** Multi-order runs are not implemented. Batched orders waited 55%
  longer at the restaurant in the Uber data, so this needs the lateness
  threshold from the cost function before it is switched on.
- **Doorstep timer and support override.** Grade D exists in the schema but
  there is no agent tooling behind it.
- **Replay harness.** The highest-value next piece: run the 92,000 historical
  orders through this dispatcher and measure the wait it would have produced.
  That validates the whole model with no drivers and no capital at risk.
