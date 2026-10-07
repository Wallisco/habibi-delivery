# Claude Code playbook — FEEST Driver app

Same method as the FEEST and ScootHero back offices. One Claude Code session per step. Start each in plan mode (Shift+Tab twice), read the plan, then let it build. Test each step on a real phone (Expo Go or an internal build) before starting the next. Paste the quoted prompt as it is.

Run Claude Code in the `habibi-delivery` folder (this repo). The spec is `driver-app/docs/driver-app-spec.md`; the rules are `driver-app/CLAUDE.md`.

**Careful:** a push to `main` in this repo deploys the dispatch server. Do every step on its own branch and merge only when it works on staging. Step 0 makes app-only changes stop triggering a server deploy.

---

## Step 0 — Find the real app, make it safe to work on
> Read driver-app/CLAUDE.md and driver-app/docs/driver-app-spec.md. Then:
> 1. Find out which version of the driver app is on drivers' phones: check the latest EAS builds (`eas build:list`) and compare their git commit with main. If they were built from code that isn't on GitHub, tell me, and stop until I give you that code.
> 2. Change .github/workflows/deploy.yml so it only deploys when files under dispatch-service/ change. App-only pushes must never redeploy the server.
> 3. Add a layout test that renders every screen at 360×640 and 390×844 and fails if anything but a list body needs scrolling.
> 4. Keep `npm test` green.
> Show me the plan first.

**Check:** a push that only touches driver-app/ runs CI but not the deploy job.

## Step 1 — Never stuck (irritations 7 and 8)
Two parts: the dispatch service first, then the app.
> Build spec section 4 rows 1–3 in dispatch-service: `GET /v1/driver/current` (with `ended` and a reason when the job was cancelled, closed or reassigned), `POST /v1/ops/drivers/:id/sign-out` (revokes tokens) and `POST /v1/ops/drivers/:id/clear-job`. Tests for each. Then in the app: check the current job every 10 seconds and on every screen change; on `ended`, show the reason in one plain sentence and go back to Home; on 401, go to sign-in. Write a test for a cancel at every step (to store, at store, to customer, at door). Deploy dispatch to staging and show me it working with a simulated driver.

**Check:** on staging, cancel an order in the back office while your phone is at each step. You're back on Home within 10 seconds every time. Sign yourself out from the back office: the phone goes to sign-in.

Then in the FEEST back office (its repo), add the **Sign driver out** and **Clear driver's job** buttons (FEEST back office spec, Drivers).

## Step 2 — FEEST look and the size system (irritations 4, 6, 13)
> Rebuild src/theme.js in FEEST colours (violet #5B2EFF, coral #FF5A36, ink #170B3B; dark text on light, the rolled-e wordmark on sign-in) with the size scale from spec section 6: primary button 48pt, secondary 40pt, body 15pt, 44pt minimum tap target. Update UI.js to use it everywhere. Rename the app "FEEST Driver" (app.json name, icon and splash placeholders). Make every screen pass the 360×640 layout test.

**Check:** side by side with Uber Driver on the same phone: no screen scrolls except lists, and nothing looks oversized.

## Step 3 — Home is the map (irritations 1, 2, 3, 5, 9, 10)
> Build spec section 2 Home: full-screen map; top bar with profile button (left), earned-today pill (centre) and the online/offline switch (right); bottom sheet with one line and one action; bottom row Trips · Earnings · Messages (red dot and count when unread) · Help. Zone from `GET /v1/driver/zone` using live position (add it to dispatch-service), never a default name; delete the Durbanville default. Demand heatmap from `GET /v1/driver/demand` (add it), refreshed every 60 s. Profile sheet with name, driver number, phone, vehicle, zone, rating and sign out. Rename "Office" to "Messages" everywhere.

**Check:** sign in at Milnerton: Milnerton shows. Sign out is one tap away. The heatmap matches open staging orders.

## Step 3a — Brands, open market and long distance
> Read spec section 2a. In dispatch-service: add brands, driver-brand approvals, the Open market and Long distance switches on the driver (`PUT /v1/driver/preferences`), offer filtering (brand approval; open-market pickups within the zone's radius, default 5 km by road; long-distance drop-offs only when switched on), brand-first ordering, no stacking across brand and open market unless the brand allows, and the brand fallback rule (spec open decision 6) with tests for each. In the app: the two switches under the online switch, locked on for drivers with no brand; the bottom sheet says what the driver is working ("KFC + open market"); brand jobs show the brand's logo and colours on the offer card and delivery screens.

**Check:** on staging, a KFC-approved driver with Open market off gets only KFC jobs; switched on, also open-market jobs within 5 km and none further; a driver with no brand can't switch Open market off.

## Step 4 — Offer card and the delivery steps
> Build the offer card (spec section 2) with a countdown ring, pay in full including stacked orders, Accept and Decline, and "Taken by another driver". Put the active delivery on one screen with the four steps across the top, one primary button per step, Navigate (Google Maps or Waze) and "Report a problem" always visible. Every screen gets a back arrow; Android back is handled on every screen (during a delivery it opens Report a problem instead of leaving).

**Check:** a full staging delivery, then a second with Android back pressed at every step: never stuck, never lost.

## Step 5 — Trips and earnings (irritations 11, 12)
> Add `period` and `daysWorked` to `GET /v1/driver/jobs`, and the cost fields and `costTargetJobs` to `GET /v1/driver/earnings` (rental per day from the ledger, fuel per day per vehicle, working days per week as settings). Trips: filter chips Today · This week · This month with days and trips; week is Monday–Sunday. Earnings: Today and This week tabs, the cost-target bar (grey through the cost jobs, then green "Profit from here"), and "Paid on Tuesday into your ScootHero wallet". Test the target maths: R1,150 a week rental, 6 working days, R40 fuel a day, R35 a job → 7 jobs.

**Check:** trip counts match earnings for each period. The bar turns green on job 8.

## Step 6 — Ratings (irritations 14, 15, 16)
> Store rating: on collection, rate the store Great / Okay / Bad from at-store to collected time (thresholds in spec open decision 4) and store it. Customer rating: on delivery.delivered, ask Keychat to send the WhatsApp rating prompt; add `POST /v1/keychat/jobs/:jobId/rating` (great|okay|bad, optional comment) with partner-key auth and a test; add it to the Keychat API change log as v1.3. In the app, show the driver's rating and recent comments on the profile sheet, and a small "Great delivery!" moment when one arrives.

**Check:** on staging, a simulated customer rating appears on the driver's profile; the store rating matches the wait. Keychat confirms the WhatsApp template is approved.

## Step 7 — Make it fun
> Add small, quick celebrations: costs covered for the day, best day this week, a 5-day streak. No sounds by default; one haptic tap. Never block the next action.

## Step 8 — Publish
> Prepare store release: privacy policy page, Google Play data safety answers, background-location declaration with the prominent disclosure screen, App Store review notes with a demo driver on staging, store listing text and screenshots from the 390×844 layout. Production EAS builds for both stores, submitted to internal testing (Play) and TestFlight.

**Check:** 10 real drivers use the TestFlight and Play internal builds for a week. Fix what they hit, then release to production.
