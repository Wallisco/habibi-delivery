# Driver app

React Native on Expo, one codebase for Google Play and the App Store.

Open `preview.html` in a browser to see the four main screens rendered in the
exact palette, without installing anything.

**Design:** white and green. The hero surface at the top of each screen is the
status signal — deep green (`#084A2C`) when the driver is earning, white when
they are not. Bright green (`#22C069`) is rationed to one primary action per
screen plus the earnings bar. Tokens live in `src/theme.js`; change them there
and the whole app follows. Built to
carry the dispatch architecture we designed: the supply state machine, the ready
gate, geofenced proof of delivery, and offline completion.

**Read the honest status section before planning around this.** This is a
working, runnable foundation with the hard logic implemented and tested. It is
not a store-ready product — the gaps are listed and they are mostly native
integration and backend, not design.

## Run it

```bash
npm install
npx expo start          # then scan the QR with Expo Go, or press a / i
npm test                # 23 behavioural tests over the state machine and proof logic
```

It runs standalone. `app.json → extra.demoMode` is `true`, so a local mock
dispatch generates offers every few seconds and you can walk a whole delivery
end to end without a backend. Set it `false` and point `extra.apiBaseUrl` at the
real service; nothing else in the app changes.

The demo OTP accepts any 4-digit code ending in an even digit.

## What is implemented

| Area | File | State |
|---|---|---|
| Supply state machine | `src/lib/supplyState.js` | Complete, tested |
| Proof grading A–D | `src/lib/proof.js` | Complete, tested |
| Geofence maths | `src/lib/proof.js` | Complete, tested |
| Offline completion queue | `src/lib/queue.js` | Complete |
| API client + mock dispatch | `src/lib/api.js` | Complete |
| App state, location watch | `src/state/store.js` | Complete |
| Sign in | `src/screens/SignInScreen.js` | UI complete, auth stubbed |
| Shift, offers | `src/screens/ShiftScreen.js` | Complete |
| Active delivery flow | `src/screens/ActiveJobScreen.js` | Complete, camera stubbed |
| Earnings | `src/screens/EarningsScreen.js` | Complete |

The rules that matter are enforced in code, not just documented:

- A driver **cannot go offline or switch to roaming while holding a job**.
- `ROAMING_ACTIVE` can only exit to `RETURNING`, so a long run always routes
  through a state where backhaul can be offered.
- **OTP entry is refused outside the geofence.** Without this a driver can phone
  ahead, get the code, and abandon the order at the gate.
- **The driver can never select leave-at-door.** `driverMaySwitchToLeaveAtDoor()`
  returns `false` and is not configurable. If a driver could choose it at the
  door, you have built an incentive to dump food and mark it delivered.
- An age-restricted order raises `minGrade` to B, which forces a leave-at-door
  order back to requiring a code.
- Offline completion downgrades the proof to grade B, and three unsynced
  completions block new offers.

## Build for the stores

```bash
npm install -g eas-cli
eas login
eas init                        # writes extra.eas.projectId
eas build --platform android --profile production   # .aab for Play
eas build --platform ios --profile production       # .ipa for App Store
eas submit --platform android
eas submit --platform ios
```

Replace before you build:

- `app.json` → `ios.bundleIdentifier` and `android.package` (currently `za.co.REPLACE.driver`)
- `app.json` → `extra.apiBaseUrl`, and set `extra.demoMode` to `false`
- `eas.json` → Apple ID, App Store Connect app ID, Apple team ID
- `eas.json` → path to your Play service account JSON
- Add `icon.png` (1024×1024) and `adaptive-icon.png`, then reference them in `app.json`

You need an Apple Developer account (USD 99/year) and a Google Play developer
account (USD 25 once). Neither can be shortcut.

## Store review — the parts that actually get rejected

**Background location is the big one.** Both stores treat it as a high-risk
permission and both will ask why you need it.

- Google Play requires a **Background Location Access declaration** plus a demo
  video showing the in-app flow that uses it. Prominent-disclosure copy must
  appear *before* the permission prompt.
- Apple will check that `NSLocationAlwaysAndWhenInUseUsageDescription` describes
  a user benefit. "For analytics" gets rejected; "so the customer can follow
  their order, and tracking stops when you go offline" does not.
- The strings in `app.json` are written to pass, but the **prominent-disclosure
  screen before the prompt is not built yet** — see gaps below.

**Also required before submission:**

- A published privacy policy URL, covering location, camera and the GPS trail
- Play Console **Data Safety** form completed — declare location, photos and
  identifiers, and whether data is shared with third parties
- Apple **App Privacy** nutrition labels
- A test account for reviewers, since the app is behind a login
- POPIA: a stated retention period for GPS trails and proof photos

Reviewers will install this and find a login wall. Give them a working demo
account or it comes straight back.

## Honest gaps

These are the things standing between this and a store build. None are hard;
all take time.

1. **No backend.** `demoMode` fakes dispatch. The real service needs the job,
   quote, completion and OTP-verify endpoints in `src/lib/api.js`.
2. **QR scanning is a button, not a scanner.** `expo-camera` is installed and
   permitted; `scanBag()` in `ActiveJobScreen` increments a counter. Wire
   `CameraView` with `onBarcodeScanned` and verify the label signature.
3. **Proof photos are stubbed.** `takePhoto()` returns a placeholder URI.
   `expo-image-picker` is installed; capture, compress, and upload with the
   evidence bundle.
4. **Foreground location only.** `expo-task-manager` is installed but no
   background task is registered, so tracking stops when the app is
   backgrounded. This is required for real deliveries and is the piece most
   entangled with store review.
5. **No push notifications.** Offers appear by local timer in demo mode. Real
   dispatch needs FCM/APNs, and offers need to wake the device.
6. **No prominent-disclosure screen** before the location prompt. Play requires it.
7. **No KYC or onboarding.** Licence, roadworthy, ID and background check are
   assumed done elsewhere. Drivers cannot be pseudonymous.
8. **No maps in-app.** Navigation deep-links to Google Maps or Apple Maps, which
   is fine for v1 and avoids a maps SDK bill.
9. **Sign-in is a phone field with no OTP.** Wire a real auth provider.
10. **No crash reporting or analytics.**

## A note on sequencing

The dispatch service should exist before this app matters. The ready gate is
what makes the driver economics work, and it can be built headless and validated
against replayed historical orders with no app and no fleet. This app is the
visible piece, but it is third in the dependency order behind merchant ready
events and dispatch.

What it is genuinely useful for right now: showing an investor or a prospective
driver what the product feels like. Run it in demo mode on a phone and the whole
proposition is legible in two minutes.
