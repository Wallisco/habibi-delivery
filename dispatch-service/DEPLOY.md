# Deployment, step by step

From your Windows machine to a live back office and an app in both stores.

Six stages. Each one is useful on its own, so stop wherever you have what you
need.

| Stage | You get | Costs |
|---|---|---|
| 1 | Code on GitHub, tests running on every push | free |
| 2 | A server with the back office on a real domain | ~R150–400/mo |
| 3 | Database persisted and backed up nightly | free |
| 4 | Real routing, so distances are billable | included |
| 5 | An installable Android APK | free |
| 6 | Both app stores | $99/yr + $25 once |

---

## Stage 1 — GitHub

### 1.1 Install Git

Download from git-scm.com, then in PowerShell:

```powershell
git --version
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

### 1.2 Create the repository

Go to github.com, click **New repository**, name it `habibi-delivery`, and make
it **Private**. Do not add a README — you already have files.

### 1.3 Push your code

```powershell
cd C:\Users\wahli\Habibi\Habibi\habibi-delivery
git init
git branch -M main
git add .
git commit -m "Dispatch service, driver app and back office"
git remote add origin https://github.com/YOURNAME/habibi-delivery.git
git push -u origin main
```

Check first that nothing sensitive is going up:

```powershell
git status --short
```

You should **not** see `node_modules`, `data/`, `.env` or `.expo`. If you do,
the `.gitignore` files are missing — stop and check before pushing.

### 1.4 Tests now run automatically

`.github/workflows/ci.yml` runs the 29 service tests, the 23 app logic tests,
and compiles every app screen through the real Expo Babel preset on every push.
That last check is the one that catches a missing dependency before it reaches
your phone.

Watch it under the **Actions** tab on GitHub.

---

## Stage 2 — The server

### 2.1 Get a machine

Any Ubuntu 24.04 box with 2 GB RAM. Host it in South Africa: latency matters for
dispatch, and POPIA is far easier to answer when personal data never leaves the
country.

- **Afrihost / Xneelo / RSAWEB** — local VPS, roughly R150–400/month
- **AWS af-south-1 (Cape Town)** — `t4g.small`, more expensive, more knobs

Note the server's IP address.

### 2.2 Point a domain at it

In your DNS provider, create an **A record**:

```
api.yourdomain.co.za   →   your.server.ip.address
```

Wait a few minutes, then confirm from PowerShell:

```powershell
nslookup api.yourdomain.co.za
```

### 2.3 Add a deploy key so the server can pull

On the server:

```bash
ssh-keygen -t ed25519 -C "dispatch-deploy" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Copy that key into GitHub → your repo → **Settings → Deploy keys → Add deploy
key**. Read-only is enough.

### 2.4 Run the setup script

SSH in as root and run:

```bash
apt-get update && apt-get install -y git
git clone git@github.com:YOURNAME/habibi-delivery.git /opt/dispatch
cd /opt/dispatch/dispatch-service
bash deploy/setup-server.sh git@github.com:YOURNAME/habibi-delivery.git api.yourdomain.co.za
```

That installs Node 22, Caddy, SQLite and a firewall; creates a `dispatch`
service user; sets up systemd, HTTPS, nightly backups and log rotation.

### 2.5 Configure it

```bash
nano /opt/dispatch/dispatch-service/.env
```

Set at minimum:

```
PUBLIC_URL=https://api.yourdomain.co.za
CUSTOMER_DELIVERY_FEE=40
KEYCHAT_WEBHOOK_URL=       # from Keychat, when they are ready
KEYCHAT_SECRET=            # generate a long random string
```

Then:

```bash
systemctl restart dispatch
systemctl status dispatch
```

### 2.6 Check it

```
https://api.yourdomain.co.za/health   →  {"ok":true,...}
https://api.yourdomain.co.za/ops      →  the back office
```

**Before you tell anyone that URL:** `/ops` exposes driver personal data and
nothing authenticates it. Turn on Caddy basic auth now.

```bash
caddy hash-password          # paste your chosen password, copy the hash
nano /etc/caddy/Caddyfile    # uncomment the basicauth block, paste the hash
systemctl reload caddy
```

The `/track/*` paths stay public deliberately — customers open them from
WhatsApp without logging in.

### 2.7 Automatic deploys

In GitHub → **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | your server IP |
| `DEPLOY_USER` | `root`, or a sudo user |
| `DEPLOY_KEY` | a private SSH key whose public half is in the server's `authorized_keys` |

Now every push to `main` that touches `dispatch-service/` backs up the database,
pulls, installs, restarts and health-checks. If the health check fails the
workflow prints the last 40 log lines and goes red.

---

## Stage 3 — The database

### 3.1 It is already connected

SQLite via Node's built-in `node:sqlite`. No server to install, no connection
string, one file at `/var/lib/dispatch/dispatch.db`. Deliberately outside the
repo, so a deploy never touches it.

Confirm:

```bash
sudo -u dispatch sqlite3 /var/lib/dispatch/dispatch.db ".tables"
curl -s localhost:3000/v1/ops/stats | grep -o '"persistence".*'
```

### 3.2 Backups

The setup script installed a nightly job at 02:15 keeping 30 days. Test a
restore now rather than discovering it does not work later:

```bash
/usr/local/bin/dispatch-backup
ls -la /var/lib/dispatch/backups/
```

It uses `sqlite3 .backup`, not `cp`. Copying the file while WAL is active
produces a corrupt backup — that distinction is the whole point.

### 3.3 When to move to Postgres

Not yet. SQLite handles a zone comfortably and removes an entire moving part.
Move when **more than one process needs to write** — a second dispatch instance,
or a separate reporting service.

Everything in `src/db.js` is plain SQL and nothing outside that file touches the
database. The migration is: swap `DatabaseSync` for a `pg` pool, change `?`
placeholders to `$1`, `INTEGER PRIMARY KEY` to `BIGSERIAL`. If you migrate
selectively, take `prep_samples` first — it is the ready gate's training data
and the one asset neither incumbent collects.

---

## Stage 4 — Routing

Without this, every quote is marked `"source": "estimated"` — straight-line
distance times 1.35. Fine for ranking dispatch candidates, **not fine to bill
on**.

On the server:

```bash
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

The extract step needs several GB of RAM and takes 20–40 minutes. If your VPS is
small, run those three steps on your laptop and copy the `.osrm*` files up.

Then set `OSRM_URL=http://127.0.0.1:5000` in `.env`, restart, and check the
**Integration** tab. Routing should read `osrm`.

---

## Stage 5 — The driver app

### 5.1 Point it at production

Edit `driver-app/app.json`:

```json
"extra": {
  "apiBaseUrl": "https://api.yourdomain.co.za",
  "demoMode": false
}
```

And replace `za.co.REPLACE.driver` in **both** `ios.bundleIdentifier` and
`android.package` with your real reverse-domain, for example
`za.co.habibi.driver`. These can never be changed after the first store
submission, so decide now.

Commit and push.

### 5.2 Set up EAS

```powershell
npm install -g eas-cli
eas login                    # free Expo account
cd C:\Users\wahli\Habibi\Habibi\habibi-delivery\driver-app
eas init                     # writes extra.eas.projectId
```

### 5.3 Build an APK you can hand to anyone

```powershell
eas build --profile preview --platform android
```

Ten minutes later EAS gives you a download link. Send it to a driver; they
install it directly. **This is how you test with real drivers and demo to
investors — no store account needed.**

### 5.4 Icons

Before a store build, add `icon.png` (1024×1024) and `adaptive-icon.png`
(1024×1024, safe area in the middle 66%) to `driver-app/assets/`, and reference
them in `app.json`.

---

## Stage 6 — The stores

### 6.1 Google Play — $25 once

1. Create a Play Console developer account.
2. Create the app. Package name must match `android.package`.
3. Build the bundle:

```powershell
eas build --profile production --platform android
```

4. Use the **Internal testing** track first — it skips full review and reaches
   your testers in hours.
5. Complete the **Data Safety** form: declare location, camera and identifiers,
   and whether data is shared with third parties.
6. Complete the **Background Location Access** declaration. Google requires a
   demo video showing the in-app flow that uses it.

### 6.2 Apple — $99/year

1. Enrol in the Apple Developer Program.
2. Create the app record in App Store Connect.
3. Build and submit:

```powershell
eas build --profile production --platform ios
eas submit --platform ios
```

4. Complete the **App Privacy** labels.
5. TestFlight first, then request App Store review.

### 6.3 What actually gets you rejected

**Background location.** Both stores treat it as high risk. Apple checks that
`NSLocationAlwaysAndWhenInUseUsageDescription` describes a user benefit — the
strings in `app.json` are written to pass. Google wants the declaration plus the
video, and a **prominent-disclosure screen before the permission prompt**, which
is not built yet.

You also need:

- A published privacy policy URL covering location, camera and the GPS trail
- A test account for reviewers, since the app is behind a login — without one it
  comes straight back
- A POPIA retention period stated for GPS trails and proof photos

Budget one rejection cycle regardless.

### 6.4 Updating without a review

`eas update` pushes JavaScript changes straight to installed apps — copy,
pricing display, layout, business logic, all live in minutes. Only native
changes (a new permission, a new SDK) need a rebuild and review.

```powershell
eas update --branch production --message "Fixed the offer sheet"
```

For a product iterating hard in its first six months, this is worth more than it
sounds.

---

## Order of operations, if you want the short version

1. Push to GitHub. **Today.**
2. Stand up the server, turn on basic auth. **This week.**
3. Build the preview APK, put it on a real driver's phone. **This week.**
4. Add OSRM before you quote anyone a price you intend to bill.
5. Store submission only once authentication exists.

**Do not skip step 2's basic auth.** An unauthenticated `/ops` on a public
domain is driver ID numbers, phone numbers and home delivery addresses exposed
to anyone who finds the URL. That is a POPIA breach, not an inconvenience.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `EADDRINUSE` | Something already on that port. `Get-Process node \| Stop-Process -Force` locally, `systemctl stop dispatch` on the server. |
| Metro moves to 8082 | An orphaned Metro still holds 8081. Kill all Node and restart. |
| Expo Go spins forever | SDK mismatch, or the phone is on mobile data. Check the Metro window shows bundling activity. |
| App cannot reach the API | On Windows: firewall and network profile. In production: `apiBaseUrl` must be **https**, or iOS blocks it. |
| Quotes say `"estimated"` | OSRM is not configured. Stage 4. |
| Webhook events stuck `DEAD` | Keychat's endpoint rejected them. Those are orders you have not been paid for — check the Integration tab. |
