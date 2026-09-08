# Architecture

Two applications and one service. The service is where all the intelligence
lives; the applications are thin.

```
  DRIVER APP                      KEYCHAT                    CUSTOMER
  React Native / Expo             WhatsApp commerce          WhatsApp
  iOS + Android                   catalogue, checkout        tracking page
      │                                │                          ▲
      │  offers, position              │  quote, order,           │
      │  scan, OTP, messages           │  POS ready event         │
      ▼                                ▼                          │
  ┌──────────────────────────────────────────────────────────────────┐
  │                        DISPATCH SERVICE                          │
  │                                                                  │
  │   API layer      driver · keychat · ops · public tracking        │
  │                                                                  │
  │   Ready gate     predicts when food is ready, per store          │
  │   Dispatcher     batching window, cost function, offer cascade    │
  │   Supply         driver positions, states, zone health            │
  │   Fees           itemised pay from the zone rate card             │
  │   Proof          OTP issue and geofenced verification             │
  │   Routing        OSRM, with a straight-line fallback              │
  │   Metrics        productivity, quality, speed, cost to serve      │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘
      │                    │                      │
      ▼                    ▼                      ▼
   SQLite            OSRM (routing)          Keychat webhooks
   or Postgres       self-hosted             retried, persisted
```

---

## Why it is shaped this way

### One app in the stores, not three

The customer orders on WhatsApp and the merchant uses the POS they already run,
so only the driver needs an app. That is one store listing, one review cycle,
one support surface and one codebase — a structural saving over every competitor,
all of whom ship three.

### The service is stateful on purpose

Dispatch holds pending jobs and driver positions in memory and solves an
assignment across all of them every few seconds. Making it stateless would mean
loading the working set from a database on every tick, which is slower and
buys nothing at a zone's volume. It is sharded by zone for fault isolation, not
throughput — a single instance comfortably serves a metro.

### Positions never touch durable storage

At 10% national share this runs at roughly **500 location writes a second
against 27,400 order events a day** — a 560:1 ratio. Writing positions to a
database would need one ten times the size for no benefit. They live in memory
(Redis in production) and only the GPS trail of a *completed* delivery is
written, as one row, as delivery evidence.

This is the single most important sizing decision in the system.

### Routing is self-hosted

Scoring every dispatch candidate through a commercial maps API would cost
roughly **R750k a month at 10% national share** — about twenty-five times the
entire infrastructure bill. OSRM on one instance handles thousands of routes a
second against South African OSM data. Turn-by-turn navigation deep-links into
the driver's own maps app, which costs nothing.

---

## The pieces

| Module | Responsibility |
|---|---|
| `src/server.js` | HTTP API. Driver, Keychat, ops and public tracking. |
| `src/readyGate.js` | Predicts kitchen readiness per store, rolling and censoring-aware. |
| `src/dispatch.js` | Batching window, cost function, offer cascade, displacement. |
| `src/supply.js` | Driver registry, geo maths, zone supply ratio, roaming premium. |
| `src/jobs.js` | Job lifecycle and the canonical job shape. |
| `src/accounts.js` | Driver accounts, onboarding state machine, documents. |
| `src/orders.js` | Order states, per-order timeline, ops-driver messaging. |
| `src/rates.js` | Per-zone rate cards, scheduled surge. |
| `src/fees.js` | Itemised driver pay, mirroring Mr D's payslip lines. |
| `src/otp.js` | Delivery codes: issue, geofence-verify, attempt caps. |
| `src/routing.js` | OSRM with a straight-line fallback. |
| `src/keychat.js` | Outbound webhooks, retries, reconciliation statement. |
| `src/metrics.js` | Back-office reporting. |
| `src/db.js` | Persistence. The only file that touches SQL. |

---

## Data model

```
accounts        who a driver is, and whether they are cleared to work
drivers         live supply state (positions stay in memory)
jobs            every order, full lifecycle, payload as JSON
evidence        completion bundles including the GPS trail
prep_samples    ready-gate training data          ← the asset
rate_cards      per-zone pricing, versioned
surge_windows   scheduled bonuses, versioned
messages        ops ↔ driver threads
outbound_events everything owed to Keychat
```

**`prep_samples` is the one table to protect.** It is what the ready gate learns
from, and neither Uber Eats nor Mr D collects it — their prep estimates
correlate −0.007 with actual readiness. Everything else can be rebuilt.

`rate_cards` and `surge_windows` are append-only. When a driver disputes a
payslip you answer with the card that was live at the time.

---

## The three ideas the business rests on

### 1. The ready gate

A job is not offered when it is placed. It becomes eligible at
*(predicted ready) − (travel to store) − buffer*.

Validated on 8,910 Uber Eats orders: mean courier wait falls from **12.31
minutes to 4.47**. Uber's estimate produces 12.31 minutes of waiting and 0.03
minutes of food sitting — that asymmetry is not a bug, it is a deliberate safety
margin paid entirely in unpaid driver time.

It learns from the merchant's label-print event, which is uncensored. A
courier's collection scan tells you when the *courier* arrived, not when the
food was ready, and training on those biases the estimate upward, which causes
later arrivals, which produces more censored samples. It compounds.

### 2. Slack, not priority

`slack = promiseAt − now − estimated duration`

Food wins early because it has minutes of slack while a parcel has hours. As the
parcel ages its slack collapses and it starts outranking fresh food on its own.
Anti-starvation for free, with no priority table to maintain.

### 3. Displacement as a cost, not a rule

A roaming job removes a driver from their zone. That costs nothing at 14:00 in a
well-supplied zone and a great deal at 17:30. Priced into the cost function, so
long runs are refused at dinner because the arithmetic says so — and the
boundary moves with actual supply rather than the clock.

---

## Proof of delivery

Every delivery closes with a proof artifact of some grade. The failure modes are
rungs on a ladder, not exceptions bolted onto a happy path.

| Grade | Means | Consequence |
|---|---|---|
| A | OTP verified online, inside the geofence | paid normally |
| B | OTP verified offline, synced later | payout held until re-verified |
| C | Photo + geofence, pre-authorised leave-at-door | paid normally |
| D | Support override, agent recorded | audited |

Two rules that are not configurable:

- **OTP entry is refused outside the geofence.** Without it a driver can phone
  ahead, collect the code, and abandon the order at the gate.
- **The driver can never select leave-at-door.** It is set by the customer at
  checkout. If a driver could choose it at the door, you have built an incentive
  to dump food and mark it delivered.

---

## Scale

| | One suburb | One metro | 10% of SA |
|---|---|---|---|
| Orders a day | 300 | 3,000 | 27,400 |
| Drivers | 35 | 350 | 3,561 |
| Peak position writes/sec | 5 | 50 | 500 |
| Monthly infrastructure | ~R2,000 | ~R11,000 | ~R28,000 |
| **Per order** | R0.22 | R0.12 | **R0.034** |

Infrastructure costs about **3.4 cents an order** at scale. Re-architecture
becomes necessary somewhere around 100,000–150,000 orders a day, which is 40% or
more of the entire South African market.

**Host in Cape Town** — AWS `af-south-1` or a local provider. POPIA is far
easier to answer when driver and customer data never leaves the country, and
dispatch is latency-sensitive: single-digit milliseconds locally against roughly
150ms to Europe.

---

## Security posture, honestly

Not yet built, and each is a real blocker for a public deployment:

- **No authentication anywhere.** `/ops` exposes driver personal data to anyone
  who can reach the port. Inbound Keychat endpoints accept jobs from anyone.
- No idempotency keys — a retried `POST /jobs` creates a duplicate order.
- No signature verification on inbound webhooks.
- No rate limiting.

The public tracking page is unauthenticated *by design*, keyed on an unguessable
job id, and deliberately exposes only a first name and vehicle type.

Until auth exists, run behind Caddy basic auth or a private network. The
`deploy/Caddyfile` has the block commented and ready.
