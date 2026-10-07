# FEEST Driver app — Build Spec

Version 1.0 · 7 October 2026 · Owner: Wahlied Cole · Written for Claude Code, the same way as the FEEST Back Office spec.

The driver app for FEEST (Habibi was the working name). One React Native / Expo codebase in `driver-app/`, published to the App Store and Google Play. It talks only to the FEEST dispatch service in this repo.

**The bar: simple.** Easy to get in, easy to get jobs, easy to move forwards and backwards. A driver on a bike, in sun, with one hand, should never wonder what to tap next, and never get stuck.

---

## 1. What drivers told us is wrong (7 Oct 2026)

Each line is a requirement. The "Check" column is how we prove it's fixed (a test, or a check on a real phone).

| # | Irritation | Cause in the code today | Requirement | Check |
|---|---|---|---|---|
| 1 | Shows "Durbanville" in the top corner when I work in Milnerton | `zone: 'Durbanville'` is the default in `src/state/store.js`, and the demo dispatch always returns Durbanville | The zone comes from the driver's live position: the zone polygon they're in, else the nearest one. Never a default name | Sign in at a Milnerton GPS fix: header shows Milnerton within 10 s |
| 2 | Want a heatmap of where most jobs are, to reposition | No demand data in the app | Home is a full-screen map with a demand heatmap (open orders and the last 30 minutes of orders, by area) | Heat cells match dispatch's demand endpoint; refreshes every 60 s while online |
| 3 | No login or logout on the front screen | Sign out is at the bottom of the Earnings screen | Profile button top-left on Home: who you are, your zone and vehicle, sign out | One tap from Home to sign out |
| 4 | Buttons oversized everywhere | `minHeight: 58`, `fontSize: 17`, 18pt padding in `UI.js` | A size scale: primary 48pt, secondary 40pt, text 15pt; tap targets never under 44pt | Every screen fits on a 360×640 phone (see 6) |
| 5 | Go offline should be in the top corner, away from navigation | It's a text button under the main actions on the shift screen | Online/offline is a switch in the top-right of Home, nowhere else | Can't be tapped by accident from the bottom half of the screen |
| 6 | Everything should fit on screen without scrolling | Screens are ScrollViews of stacked cards | Every screen fits a 360×640 phone without scrolling. Only lists (trips, messages) scroll, and their header and filters stay fixed | Automated layout check at 360×640 and 390×844 |
| 7 | When stuck in a loop, the back office should be able to log me off | No such action | Back office: "Sign driver out" and "Clear driver's job". The app returns to sign-in or Home within 10 s | Back-office action → phone reacts within 10 s |
| 8 | A job cancelled in the back office keeps me stuck in a loop | The app is never told a job was cancelled, closed or reassigned; there's no cancel handling in the app at all | The app checks its current job with dispatch every 10 s and on every screen change. Cancelled, closed or reassigned → a clear message ("The office cancelled this order. No action needed.") and back to Home | Cancel from the back office at each stage (to store, at store, to customer, at door): app is home within 10 s, every time |
| 9 | Not sure who I'm signed up as on the shift screen | The header shows no driver identity | Profile button shows first name and photo initial; the profile sheet shows name, driver number, phone, vehicle, zone | Visible on Home without a tap |
| 10 | "Office" should say "Messages" and change colour with unread messages | Screen titled "Office" | Named "Messages", with a red dot and count when unread | New message from the back office → red dot within 10 s |
| 11 | My trips: add header filters (today, this week, this month) with number of days | No filters | Filter chips: Today · This week · This month, each with trips and days worked, e.g. "This week · 4 days · 37 trips". Week is Monday–Sunday | Counts match the earnings screen for the same period |
| 12 | Earnings today: target jobs to pay for the vehicle and fuel; everything after is profit | No cost target; a hard-coded R900 weekly vehicle fee | "Jobs to cover your bike and fuel today: 6". A bar fills grey through the cost jobs, then green: "Profit from here". Costs come from the driver's ledger (rental per day) and a fuel estimate per vehicle | With R1,150/week rental and R40 fuel a day at R35 a job: target = ceil((1150/6 + 40) ÷ 35) = 7 jobs (6 working days a week, set in the back office) |
| 13 | Make the interface cleaner and more fun | Dense cards | FEEST look (violet and coral, the rolled "e"), one action per screen, small celebrations: cost covered, daily best, streaks | Review on a real phone against Uber Driver (section 3) |
| 14 | Driver ratings by customers | None | After delivery, the customer gets a WhatsApp message: "How was your delivery?" Great · Okay · Bad. Okay or Bad asks "How can we improve?" | A delivered staging order produces the WhatsApp prompt; the answer shows on the driver's profile |
| 15 | Store rating by order collected on time | None | Every collection rates the store automatically: Great (food ready when the driver arrived), Okay (driver waited up to 5 minutes), Bad (over 5 minutes) | Rating matches the store-wait time recorded for that order |
| 16 | Use a 3-level rating: bad, okay, great | — | Both ratings use the same three levels, shown as faces or 1–3 stars | — |
| 17 | Take cues from the Uber Driver app | — | Section 3 | — |

---

## 2. Screens

Five places, all one tap from Home. Every screen has a back arrow top-left (and Android back works), except Home and an active delivery step, which have a clear "Report a problem" instead.

### Home (the map)
- Full-screen OpenStreetMap map, centred on the driver.
- **Top bar:** profile button (left) · earned today pill (centre, tap → Earnings) · online/offline switch (right).
- **Demand heatmap** while online and offline, so a driver can see where to go before going online.
- **Bottom sheet**, one line and one action:
  - Offline: "You're offline · Milnerton" + Go online.
  - Online, waiting: "Finding jobs near you" + the cost-target bar ("3 of 7 jobs to cover costs").
  - Offer: the offer card (below) replaces the sheet.
- Bottom row (small icons with labels): Trips · Earnings · Messages (red dot when unread) · Help.

### Offer card
Pickup store and distance, drop-off suburb, pay for this job (all in, with any stacked orders listed), time to collect, a countdown ring, **Accept** (primary) and **Decline** (secondary). Five drivers see it; the first to accept gets it. If someone else takes it: "Taken by another driver", and the card slides away.

### Active delivery (one screen, steps across the top)
To store → At store (scan) → To customer → At door (code and photo). One primary button per step. "Navigate" opens Google Maps or Waze at the next stop. "Report a problem" is always visible: before collection, the driver can hand the job back with no penalty; after collection, it goes to the office incident queue, and the office can clear it.

### Trips
Filter chips: Today · This week · This month, with days and trips. Each row: time, store, suburb, pay. Tap → trip detail with the pay lines.

### Earnings
- **Today:** earned, jobs, the cost-target bar, and "profit so far".
- **This week (Mon–Sun):** earned, rental deducted, net, and "Paid on Tuesday into your ScootHero wallet" (Altron), with last week's payout.
- No scrolling: today and this week side by side as two tabs.

### Profile sheet (from the top-left button)
Name, driver number, phone, vehicle, zone, rating (from customers), sign out, app version.

### Messages
"Messages" with unread count. Templates for quick replies ("On my way", "Can't find the store").

---

## 2a. Brands, open market and long distance (added 7 Oct 2026)

FEEST runs two ways at once:
- **FEEST (open market):** stores sell under the FEEST name; any FEEST driver can deliver.
- **White label (brand):** a chain such as KFC gets its own branded version. Customers see the brand's name, logo and colours on WhatsApp ordering, the tracking page and messages. Deliveries go to drivers approved for that brand (often in the brand's kit and box).

**Drivers are one shared pool.** Every driver is signed up to the open market. The back office approves selected drivers for a brand. There is one app, FEEST Driver, for everyone; a brand job shows in the brand's colours and logo on the offer card and delivery screens.

**Two switches on Home, under the online switch (top-right):**

| Switch | Off | On |
|---|---|---|
| **Open market** | Only jobs for the brand(s) the driver is approved for | Also FEEST open-market jobs picked up within 5 km of where the driver is now |
| **Long distance** | Only jobs whose drop-off is within the normal delivery distance | Also long-distance trips (drop-off further than the zone's normal limit), paid per km at the zone's long-distance rate |

Rules:
- A driver with no brand approval works the open market only; the Open market switch is on and locked for them.
- Brand drivers see their brand's jobs first. With Open market on, open-market offers are also shown, but a brand job is never offered behind an open-market one when both arrive together.
- A branded job and an open-market job are never stacked on the same run (different branded boxes and promises), unless the brand allows it.
- The 5 km is measured by road from the driver's live position to the pickup, and is a setting per zone (default 5 km).
- The switches remember their last setting per driver and are shown in the bottom sheet text, e.g. "Online · KFC + open market · long distance on".

Dispatch order for a brand job (open decision 6 for the fallback):
1. The 5 closest online drivers approved for that brand.
2. Then the next 5 brand drivers.
3. If no brand driver accepts within the brand's wait limit, either the order goes to open-market drivers (if the brand allows it) or the office is alerted.

What changes elsewhere:
- **Dispatch:** brands and driver-brand approvals; offers filtered by brand approval, the Open market switch with its 5 km radius, and the Long distance switch; the stacking rule above; rate cards per brand and zone.
- **Back office:** a Brands section (name, logo, colours, WhatsApp sender, tracking page look, rules: fallback to open market yes/no, wait limit, stacking allowed); approve drivers per brand on the driver page; brand filter on the Overview and Metrics.
- **Keychat:** each brand's WhatsApp ordering runs on its own (or the store's) WhatsApp number and branding; the tracking link and rating messages use the brand.

---

## 3. Cues from the Uber Driver app

What we copy, and why:
- **Map first.** The home screen is the map, with demand shading, because where to be is the driver's main decision.
- **Status and earnings always visible** at the top, small.
- **Online switch away from everything else.**
- **Offer card with a countdown**, big pay figure, one accept action.
- **Trip steps in one screen** with a single primary action each.
- **Earnings in periods** (today, week) with a clear payout day.
- **Ratings shown to the driver**, with what customers said.

What we do better:
- **Pay shown before accepting, all in**, including stacked orders (Uber hides parts).
- **The cost target**: drivers on a ScootHero rental see exactly when the day turns to profit.
- **Never stuck:** the office can always clear a job or sign a driver out.

---

## 4. What the dispatch service must add (this repo)

| Need | Endpoint or change |
|---|---|
| Driver's current job state, to escape cancelled jobs | `GET /v1/driver/current`: job, status, and `ended` with a reason if cancelled, closed or reassigned |
| Office signs a driver out | `POST /v1/ops/drivers/:id/sign-out`: revokes the driver's tokens; the app's next call gets 401 and goes to sign-in |
| Office clears a stuck job | `POST /v1/ops/drivers/:id/clear-job`: ends the driver's current job (order goes back to dispatch or is closed, the office chooses) |
| Zone from position | `GET /v1/driver/zone?lat&lng`: the zone polygon the point is in, else the nearest |
| Demand heatmap | `GET /v1/driver/demand?lat&lng&radiusKm=8`: cells (about 500 m) with open orders and the last 30 minutes' orders. No customer data |
| Cost target | `GET /v1/driver/earnings` adds `costs: { rentalPerDay, fuelPerDay, workDaysPerWeek }` and `costTargetJobs` |
| Trips by period | `GET /v1/driver/jobs?period=today|week|month` with `daysWorked` and counts |
| Brands and switches | Brands, driver-brand approvals, the Open market (radius per zone, default 5 km) and Long distance switches on the driver's state; offers filtered by them; no stacking across brand and open market unless the brand allows; rate cards per brand and zone. `PUT /v1/driver/preferences` `{ openMarket, longDistance }` |
| Ratings | Store rating written on collection from the at-store and collected times. Customer rating: on `delivery.delivered`, ask Keychat to send the WhatsApp rating prompt; Keychat posts the answer to `POST /v1/keychat/jobs/:jobId/rating` (`great|okay|bad`, optional comment) |

The Keychat rating prompt needs a WhatsApp template approved on Keychat's WhatsApp Business account. Add it to the Keychat API change log (v1.3) and agree the wording with Keychat.

## 5. What the FEEST back office must add

In its Drivers module (back office playbook step 5): **Sign driver out** and **Clear driver's job** buttons (ops lead and dispatcher, with a reason, audited), and driver and store ratings with comments. Store ratings also show on the vendor page.

---

## 6. Rules for every change

- **Fits without scrolling** on a 360×640 Android phone and a 390×844 iPhone, except list bodies.
- **Never stuck:** every screen has back (or "Report a problem" during a delivery), Android back is handled, and the app always recovers from a cancelled, closed or reassigned job.
- **One primary action per screen.**
- **Plain words:** "Messages", not "Office"; "Go online", not "Commit to zone".
- **Sizes from the theme:** primary button 48pt, secondary 40pt, body text 15pt, minimum tap target 44pt.
- **Location** only while online or on a delivery; the Google Play prominent disclosure screen before asking for background location.
- **Tests:** every state change and every recovery path has a test in `__tests__`; layout checks run at both phone sizes.

## 7. Publishing

- **Name:** FEEST Driver. Listing, icon and splash in FEEST colours.
- **Identifiers:** the current bundle id is `za.co.habibi.driver` (Expo account `habibidriver`). If the app is not yet live in either store, change it now to a FEEST id; once published, it can never change. Open decision 1.
- **Accounts:** Apple Developer and Google Play accounts in the company that will own the app. Open decision 2.
- **Store requirements:** privacy policy URL, Google Play data safety form, background location declaration with the disclosure screen and a short video, Apple review notes with a demo driver login on staging.
- **Release path:** EAS builds → internal testing (Play) and TestFlight → 10 real drivers for a week → production.

## 8. Open decisions

1. Bundle id: keep `za.co.habibi.driver` or change to a FEEST id before first publish.
2. Which company publishes the app (ScootHero, Quikr, or a FEEST company).
3. Fuel estimate per vehicle type, and working days per week for the cost target (proposed: 6).
4. Store rating thresholds (proposed: ready on arrival = Great; up to 5 min wait = Okay; over 5 min = Bad).
5. Which version is on drivers' phones now. GitHub's `driver-app/` was last changed on 22 Sep 2026 (order stacking); later fixes (report a problem, back buttons, auth) may only be on someone's laptop. Step 0 finds out.
6. Brand jobs with no brand driver available: fall back to open-market drivers after the brand's wait limit, or alert the office only. Proposed: per brand, default fall back after 3 minutes.
7. Long distance: what counts as long (proposed: drop-off more than 8 km by road) and its per-km rate per zone.
8. Whether brand drivers are paid on the brand's rate card or the FEEST one when doing brand jobs.
