# Fresh install, step by step

From an empty folder to a working system. Six stages, each useful on its own.

Everything runs from `C:\Users\wahli\Habibi\Habibi_v3`.

---

## Stage 1 — Get the files onto your PC

Download **`habibi-delivery.zip`**, then in PowerShell:

```powershell
cd C:\Users\wahli\Habibi\Habibi_v3
Expand-Archive -Path "$HOME\Downloads\habibi-delivery.zip" -DestinationPath . -Force
dir -Force
```

`-Force` on `dir` matters — Explorer and plain `dir` hide dotfiles, and `.github`
and `.gitignore` both need to be there.

You should see:

```
.github          .gitignore       README.md
dispatch-service driver-app       install.ps1
setup-repo.ps1   testjobs.sh
```

**If it nested an extra folder** — `Habibi_v3\habibi-delivery\dispatch-service` —
move the contents up a level, or just work from the deeper folder. The folder
name on your PC does not matter; only the git remote decides which repo it
pushes to.

---

## Stage 2 — Install and verify locally

Save `install.ps1` into `Habibi_v3` if it is not already there, then:

```powershell
cd C:\Users\wahli\Habibi\Habibi_v3
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

That one command:

- checks all 24 key files are present, and names any that are missing
- checks Node is version 20 or newer
- writes `app.json` — API URL, `demoMode: false`, bundle ID, EAS project ID
- installs both projects
- runs 43 service tests and 23 app tests
- compiles every app screen through the real Expo Babel preset
- sets your git identity and editor, writes `.gitignore`, initialises the repo
- refuses to continue if `node_modules` or a `.env` is staged

It pushes nothing and deploys nothing. Those are deliberate, separate steps.

**If it stops**, it names the file or the reason. The two common ones are a
missing file (re-extract the zip) and Node being too old.

### Check it actually works

```powershell
cd dispatch-service
npm start
```

Open `http://localhost:3000/ops`. You should get the back office with seven
tabs. `Ctrl+C` in that window when you are done looking.

---

## Stage 3 — Push to GitHub

```powershell
cd C:\Users\wahli\Habibi\Habibi_v3
git add -A
git commit -m "Habibi delivery platform"
git push -u origin main
```

A browser opens to sign in. **If the terminal asks for a password instead**, that
path is dead — GitHub stopped accepting passwords in 2021. Create a token at
github.com → Settings → Developer settings → Personal access tokens → Tokens
(classic), tick `repo`, and paste the token where it asks for a password.

**If the push is rejected** because the remote has commits you do not:

```powershell
git pull --no-rebase
git push -u origin main
```

If a merge conflict appears on `README.md`, keep yours:

```powershell
git checkout --ours README.md
git add README.md
git commit -m "Merge"
git push
```

Then watch **github.com/Wallisco/habibi-delivery/actions**. Green means
everything passed on a clean machine, which is a stronger signal than passing
on yours.

---

## Stage 4 — Deploy to the server

The server at `169.255.59.165` is already provisioned. Deploying is three lines:

```powershell
ssh root@169.255.59.165
```

```
cd /opt/dispatch && git pull && systemctl restart dispatch
```

```
curl -s localhost:3000/health
```

`{"ok":true,...}` means it is running.

**Always check the thing you expected actually arrived.** A pull that silently
brings nothing looks identical to a pull that worked:

```
grep -c "pickupName" /opt/dispatch/dispatch-service/src/server.js
ls /opt/dispatch/dispatch-service/public/vendor/
```

You want `1`, and `leaflet.js` / `leaflet.css` / `images`.

Then in the browser, **Ctrl+Shift+R** on `https://habibi-api.quikr.co.za/ops`.
A normal refresh serves the cached page and looks like the deploy failed.

### Environment

```
nano /opt/dispatch/dispatch-service/.env
```

```
PUBLIC_URL=https://habibi-api.quikr.co.za
DB_PATH=/var/lib/dispatch/dispatch.db
CUSTOMER_DELIVERY_FEE=40
# KEYCHAT_WEBHOOK_URL=      leave commented until Keychat give you an endpoint
# OSRM_URL=                 leave commented until Stage 6
```

`PUBLIC_URL` matters more than it looks: without it the customer tracking links
go out as `/track/JOB-xxx` with no domain, which is useless to Keychat.

```
systemctl restart dispatch
```

---

## Stage 5 — Build the driver app

```powershell
cd C:\Users\wahli\Habibi\Habibi_v3\driver-app
eas login
eas build --profile preview --platform android
```

Ten to twenty minutes, then a download link. Open it **on the phone** and
install. Android warns about an unknown source; allow it.

**On a Samsung**, Auto Blocker will refuse the install regardless of every other
setting. Settings → Security and privacy → **Auto Blocker** → off. Also turn off
Play Protect scanning temporarily: Play Store → profile → Play Protect → gear →
off.

That APK talks straight to `habibi-api.quikr.co.za`. No Metro, no laptop, no
wifi — you can drive a route on mobile data.

### If the build fails

- **"Invalid UUID appId"** — `app.json` lost its EAS project ID. Re-run
  `install.ps1`, which writes it back.
- **Gradle failure listing dozens of missing libraries** — Expo's artifact
  cache having a bad moment. Retry; check status.expo.dev if it happens twice.

---

## Stage 6 — Routing (before you bill anyone)

Until this is done, every distance is straight-line × 1.35 and every quote is
marked `"source": "estimated"`. That is fine for ranking dispatch candidates and
**not** fine to bill Keychat on.

On the server:

```
apt-get install -y docker.io
mkdir -p /opt/osrm && cd /opt/osrm
wget https://download.geofabrik.de/africa/south-africa-latest.osm.pbf

docker run -t -v "${PWD}:/data" osrm/osrm-backend \
  osrm-extract -p /opt/car.lua /data/south-africa-latest.osm.pbf
docker run -t -v "${PWD}:/data" osrm/osrm-backend \
  osrm-partition /data/south-africa-latest.osrm
docker run -t -v "${PWD}:/data" osrm/osrm-backend \
  osrm-customize /data/south-africa-latest.osrm

docker run -d --restart always -p 127.0.0.1:5000:5000 -v "${PWD}:/data" \
  --name osrm osrm/osrm-backend osrm-routed --algorithm mld \
  /data/south-africa-latest.osrm
```

The extract step wants several GB of RAM and takes 20–40 minutes. On a 2 GB
server it will fail — run those three steps on your laptop and copy the `.osrm*`
files up.

Then uncomment `OSRM_URL=http://127.0.0.1:5000` in `.env`, restart, and check the
**Integration** tab reads `osrm`.

---

## Testing the whole loop

**Onboard a driver.** Sign in on the app, then in the back office → Drivers →
Open → verify all six documents → add a vehicle registration → ACTIVE. Nothing
is dispatchable until then, and that is deliberate.

If the buttons will not respond, do it from the server:

```
for d in id_document drivers_licence roadworthy insurance police_clearance bank_confirmation; do
  curl -s -X POST localhost:3000/v1/ops/accounts/100000/document \
    -H 'content-type: application/json' -d "{\"docKey\":\"$d\",\"status\":\"VERIFIED\"}" > /dev/null
done
curl -s -X PATCH localhost:3000/v1/ops/accounts/100000 -H 'content-type: application/json' \
  -d '{"vehicleReg":"CA 123-456","zone":"Milnerton"}' > /dev/null
curl -s -X POST localhost:3000/v1/ops/accounts/100000/onboarding \
  -H 'content-type: application/json' -d '{"state":"ACTIVE"}'
```

**Create a job you can walk.** Use your own coordinates for both ends — long-press
your location in Google Maps to get them — and the geofences open where you are
standing:

```
curl -s -X POST localhost:3000/v1/keychat/jobs -H 'content-type: application/json' \
  -d '{"externalId":"WALK-1","storeId":"TEST-STORE","zone":"Milnerton",
       "pickup":{"lat":YOUR_LAT,"lng":YOUR_LNG,"name":"Test pickup"},
       "dropoff":{"lat":YOUR_LAT,"lng":YOUR_LNG,"name":"Test dropoff"},
       "customerCharge":40,"tip":20,"prepMinutes":5,"createdAt":0}'
```

`createdAt: 0` backdates it so the ready gate releases it immediately.

**Walk it.** Go online → accept → "I am at the restaurant" → scan → "I have
arrived" → the code appears on the order detail in the back office → enter it →
delivered, with the full pay breakdown.

`testjobs.sh` creates ten at once around Milnerton Galleria if you want volume.

---

## When something does not work

| Symptom | Cause |
|---|---|
| `apt-get` not recognised | You are in PowerShell. `ssh root@169.255.59.165` first. |
| `Invoke-RestMethod` not found | You are on the server. Use `curl`. |
| `&&` is not a valid separator | PowerShell. Split into two lines, or run it on the server. |
| Back office looks unchanged | Browser cache. **Ctrl+Shift+R**, or an incognito window. |
| Pull brought nothing | The file never saved on your PC. `git status` would have shown a change. |
| Quotes say `"estimated"` | OSRM not configured. Stage 6. |
| App shows a document checklist | The driver is not ACTIVE yet. That is correct behaviour. |
| Events stuck `DEAD` | `KEYCHAT_WEBHOOK_URL` points nowhere. Comment it out. |

**The prompt tells you which machine you are on.** `PS C:\...>` is your PC;
`root@habibi-dispatch-01:~#` is the server. More than half the errors in this
build came from running a command on the wrong one.

---

## Still outstanding

Honest list, in the order I would tackle it:

1. **No authentication on the API.** `/v1/driver/*` and `/v1/keychat/*` are open
   to anyone who finds the URL. This is the blocker before real orders.
2. **`/ops` behind one shared password.** No per-staff accounts, no audit of who
   approved which driver.
3. **No idempotency keys** — a retried `POST /jobs` creates a duplicate order.
4. **Batching is priced and tested but not dispatched.** `canJoin` exists;
   `solve()` still assigns one job at a time, and the app has no multi-stop UI.
5. **QR scanning is a button**, not a scanner. Proof photos are stubbed.
6. **Foreground location only**, and Google Play's prominent-disclosure screen
   is not built — both required for store submission.
