#!/usr/bin/env bash
# Put a branch on STAGING only, to test it before it goes anywhere near main.
# Production (/opt/dispatch, service "dispatch", port 3000) is never touched.
#
#   sudo bash /opt/dispatch-staging/dispatch-service/deploy/stage-branch.sh driver-app-track
#
# The first time, staging is still on main and has no copy of this script:
#   sudo -u dispatch git -C /opt/dispatch-staging fetch origin driver-app-track
#   sudo -u dispatch git -C /opt/dispatch-staging reset --hard FETCH_HEAD
# then run the line above.
#
# Note: the next push to main that touches dispatch-service/ deploys main to
# staging again (.github/workflows/deploy.yml).
set -euo pipefail

BRANCH="${1:?usage: stage-branch.sh <branch>}"
BASE=/opt/dispatch-staging
ENVF="$BASE/dispatch-service/.env"

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)."; exit 1; }
[ -d "$BASE/.git" ] || { echo "Staging is not set up. Run deploy/add-staging.sh first."; exit 1; }
grep -q '^DISPATCH_ENV=staging' "$ENVF" || { echo "$ENVF does not say DISPATCH_ENV=staging. Refusing."; exit 1; }
# .env.example points at Keychat's live webhook. Staging must not post there.
if grep -q '^KEYCHAT_WEBHOOK_URL=https://api.keychat.co.za/webhooks/delivery' "$ENVF"; then
  echo "$ENVF still sends webhooks to Keychat's live URL."
  echo "Set KEYCHAT_WEBHOOK_URL to Keychat's test URL, or leave it empty, then run this again."
  exit 1
fi

echo "==> code ($BRANCH)"
cd "$BASE"
sudo -u dispatch git fetch origin "$BRANCH"
sudo -u dispatch git reset --hard FETCH_HEAD
echo "staging is at: $(sudo -u dispatch git log --oneline -1)"

echo "==> dependencies"
cd "$BASE/dispatch-service"
sudo -u dispatch npm ci --omit=dev || sudo -u dispatch npm install --omit=dev

echo "==> restart staging"
systemctl restart dispatch-staging
sleep 3
if ! curl -fsS http://127.0.0.1:3001/health | grep -q '"env":"staging"'; then
  journalctl -u dispatch-staging -n 40 --no-pager
  exit 1
fi
echo "Staging is running $BRANCH. Production was not touched."
