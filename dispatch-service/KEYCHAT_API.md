# Keychat integration contract

Two systems, one order. Keychat owns the customer and the transaction record.
We own routing, dispatch, the fleet and delivery execution.

```
Keychat                                    Dispatch service
   │                                              │
   │─── POST /v1/keychat/quote ──────────────────▶│  we route + price
   │◀── customerCharge + itemised driverCost ─────│
   │                                              │
   │   customer pays, tip selected at checkout    │
   │                                              │
   │─── POST /v1/keychat/jobs ───────────────────▶│  we route again, store it
   │◀── jobId + dispatchAtMinutes ────────────────│
   │                                              │
   │─── POST /v1/keychat/jobs/:id/ready ─────────▶│  POS says the order is up
   │                                              │
   │◀── delivery.assigned ────────────────────────│  webhooks from here on
   │◀── delivery.collected ───────────────────────│
   │◀── delivery.code_issued  (OTP) ──────────────│  Keychat shows the customer
   │◀── delivery.delivered  (final charge) ───────│  order closes, we bill
```

## Who holds what

| | Keychat | Us |
|---|---|---|
| Customer identity and transaction record | yes | |
| Menu, catalogue, checkout, payment | yes | |
| Delivery OTP **displayed** to the customer | yes | |
| Delivery OTP **generated and verified** | | yes |
| Routing and distance | | yes |
| Ready gate and dispatch | | yes |
| Driver onboarding, vetting, pay, performance | | yes |

The OTP split matters. Keychat shows the code because they own the customer
conversation, but verification has to happen against the driver's live GPS
position and we are the only party holding it. They display, we adjudicate.

Driver management is entirely ours. Keychat never sees a driver record beyond
the first name and vehicle shown to a customer tracking their order.

---

## 1. Quote — before the customer pays

`POST /v1/keychat/quote`

```json
{
  "storeId": "MILNERTON-GALLERIA",
  "zone": "Milnerton",
  "pickup":  { "lat": -33.8703, "lng": 18.5089 },
  "dropoff": { "lat": -33.8790, "lng": 18.5210 },
  "prepMinutes": 18,
  "bagCount": 1,
  "tip": 0
}
```

`prepMinutes` is the merchant's own estimate from their POS. We use it **only
while a store is cold**. Once we have measured that kitchen ourselves we use our
own number — Uber's equivalent estimate correlated −0.007 with actual readiness
across 11,900 orders and ran 12.3 minutes low by design.

Response:

```json
{
  "quoteId": "Q-m4x2k1-a9f3",
  "expiresInSeconds": 180,
  "currency": "ZAR",
  "customerCharge": { "deliveryFee": 40.00, "tipIsSeparate": true },
  "driverCost": {
    "lines": [
      { "code": "COLLECTION_BASE", "label": "Collection base fee",  "amount": 6.50 },
      { "code": "COLLECTION_KM",   "label": "Per km to collection", "amount": 0.69 },
      { "code": "DELIVERY_BASE",   "label": "Delivery base fee",    "amount": 21.00 },
      { "code": "DELIVERY_KM",     "label": "Per km to customer",   "amount": 2.45 },
      { "code": "FUEL",            "label": "Fuel surcharge",       "amount": 1.47 }
    ],
    "total": 32.11
  },
  "margin": 7.89,
  "routing": { "collectKm": 0.9, "deliverKm": 1.99, "drivingMinutes": 5.4, "source": "osrm" },
  "timing": {
    "etaMinutes": 30,
    "merchantPrepMinutes": 18,
    "ourPrepEstimateMinutes": 18,
    "prepSource": "merchant",
    "driverDispatchAtMinutes": 15.5
  }
}
```

**Add `customerCharge.deliveryFee` to the order total.** The tip is collected
separately at checkout and passed through to the driver in full.

`driverCost` is what the delivery will cost us, itemised. It is on the quote so
reconciliation is arithmetic rather than a negotiation at month end. `margin` is
stated rather than implied.

`driverDispatchAtMinutes` is when we intend to send a driver. If a merchant
disputes a courier arriving too early or too late, that number is the answer.

`routing.source` is `osrm` when we routed properly and `estimated` when we fell
back to straight-line distance. Only `osrm` should be billed on.

## 2. Create the delivery — after payment

`POST /v1/keychat/jobs`

```json
{
  "externalId": "KC-1001",
  "quoteId": "Q-m4x2k1-a9f3",
  "storeId": "MILNERTON-GALLERIA",
  "zone": "Milnerton",
  "pickup":  { "lat": -33.8703, "lng": 18.5089, "name": "Milnerton Galleria" },
  "dropoff": { "lat": -33.8790, "lng": 18.5210, "name": "14 Wellington St" },
  "prepMinutes": 18,
  "expectedReadyAt": 1788350000000,
  "customerCharge": 40.00,
  "tip": 20.00,
  "bagCount": 2,
  "deliveryMode": "HANDOFF_REQUIRED",
  "ageRestricted": false
}
```

`tip` must be the amount the customer **committed at checkout**. It is shown to
the driver in the offer as part of an all-inclusive figure, which is what makes
the number they accept the number they are paid.

`deliveryMode` is `HANDOFF_REQUIRED` or `LEAVE_AT_DOOR`, set by the customer. A
driver can never select leave-at-door themselves — that would create an
incentive to abandon food and mark it delivered.

Response:

```json
{ "jobId": "JOB-a1b2c3d4",
  "status": "PENDING",
  "routing": { "collectKm": 0.9, "deliverKm": 1.99, "source": "osrm" },
  "dispatchAtMinutes": 15.5 }
```

## 3. Order ready — from the POS

`POST /v1/keychat/jobs/:jobId/ready`

Fire this when the merchant's POS prints the bag label or marks the order up.

**This is the single most valuable call in the integration.** The print
timestamp is uncensored, unlike a courier's collection scan, and it is what
trains the ready gate. Neither Uber Eats nor Mr D collects it. Without it we
learn from collection times, which are materially worse.

## 4. Webhooks — we call you

Set `KEYCHAT_WEBHOOK_URL`, and optionally `KEYCHAT_SECRET` which is sent as
`x-dispatch-signature`. Retried five times with backoff and persisted across
restarts: a missed `delivery.delivered` means the order never closes and we are
never paid, which is silent revenue loss.

| Event | Payload |
|---|---|
| `delivery.accepted` | jobId, externalId, quoteId, etaMinutes |
| `delivery.assigned` | jobId, driverId |
| `delivery.merchant_ready` | jobId, prepMinutes |
| `delivery.collected` | jobId, waitAtStoreMinutes |
| `delivery.code_issued` | jobId, **code** — show this to the customer |
| `delivery.delivered` | jobId, externalId, grade, `charge` |
| `delivery.failed` | jobId, reason |

`delivery.delivered` carries the final reconcilable charge:

```json
{
  "charge": {
    "customerCharge": 40.00,
    "driverCost": 32.11,
    "tipPassedThrough": 20.00,
    "margin": 7.89,
    "lines": [ "...every fee line..." ]
  }
}
```

## 5. Reconciliation

`GET /v1/keychat/statement?days=7`

Every delivered order with its customer charge, driver cost, tip passed through,
margin and full fee lines — so a dispute lands on one row rather than the whole
invoice.

## Configuration

| Variable | Purpose |
|---|---|
| `OSRM_URL` | Self-hosted routing. Without it distance is straight-line × 1.35 and every quote is marked `"source": "estimated"` — fine for ranking dispatch candidates, not fine to bill on. |
| `KEYCHAT_WEBHOOK_URL` | Where we POST events. Unset means events are recorded but not delivered. |
| `KEYCHAT_SECRET` | Sent as `x-dispatch-signature`. |
| `CUSTOMER_DELIVERY_FEE` | What Keychat charges the customer. Default R40. |

Check both with `GET /v1/ops/integration`.

### Running OSRM

```bash
wget https://download.geofabrik.de/africa/south-africa-latest.osm.pbf
docker run -t -v "${PWD}:/data" osrm/osrm-backend \
  osrm-extract -p /opt/car.lua /data/south-africa-latest.osm.pbf
docker run -t -v "${PWD}:/data" osrm/osrm-backend \
  osrm-partition /data/south-africa-latest.osrm
docker run -t -v "${PWD}:/data" osrm/osrm-backend \
  osrm-customize /data/south-africa-latest.osrm
docker run -d -p 5000:5000 -v "${PWD}:/data" osrm/osrm-backend \
  osrm-routed --algorithm mld /data/south-africa-latest.osrm

OSRM_URL=http://localhost:5000 npm start
```

One instance handles thousands of routes a second. Routing every dispatch
candidate through a commercial maps API instead would cost roughly R750k a month
at 10% national share — about twenty-five times the entire infrastructure bill.

## Not built yet

- **No authentication on inbound endpoints.** Anyone who can reach the port can
  create jobs. This is the blocker before anything leaves a private network.
- No idempotency keys, so a retried `POST /jobs` creates a duplicate.
- No signature verification on inbound calls from Keychat.
- `delivery.failed` is defined but the disposition flow behind it is not built.
