#!/usr/bin/env bash
# One-time: add the staging environment beside production on the same server.
# Run as root after setup-server.sh.
#   bash deploy/add-staging.sh habibi-staging.quikr.co.za
#
# Staging is where Keychat integrates. Same code, its own database, port 3001,
# DISPATCH_ENV=staging: simulated drivers deliver every order in ~2-3 minutes,
# dispatchNow is honoured and the tracking page shows a TEST badge.
set -euo pipefail

DOMAIN="${1:?usage: add-staging.sh <staging-domain>}"
BASE=/opt/dispatch-staging
DATA=/var/lib/dispatch-staging

echo "==> code"
if [ ! -d "$BASE/.git" ]; then
  git clone "$(git -C /opt/dispatch remote get-url origin)" "$BASE"
fi
chown -R dispatch:dispatch "$BASE"
cd "$BASE/dispatch-service"
sudo -u dispatch npm ci --omit=dev || sudo -u dispatch npm install --omit=dev

echo "==> data"
mkdir -p "$DATA/backups" && chown -R dispatch:dispatch "$DATA"

echo "==> environment"
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i \
    -e "s|^PORT=.*|PORT=3001|" \
    -e "s|^DB_PATH=.*|DB_PATH=$DATA/dispatch.db|" \
    -e "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" \
    .env
  printf '\n# --- environment\nDISPATCH_ENV=staging\n' >> .env
  echo "!! Set KEYCHAT_WEBHOOK_URL / KEYCHAT_SECRET in $BASE/dispatch-service/.env to Keychat's TEST endpoint"
fi

echo "==> partner test key"
if ! grep -q '^PARTNER_API_KEYS=.\+' .env; then
  OUT=$(sudo -u dispatch node scripts/new-partner-key.js keychat-test)
  echo "$OUT"
  LINE=$(echo "$OUT" | grep -o 'keychat-test:[0-9a-f]\{64\}' | head -1)
  sed -i "s|^PARTNER_API_KEYS=.*|PARTNER_API_KEYS=$LINE|" .env
  echo "!! Give Keychat the hbk_test_ key printed above, through a secure channel. It is not stored."
fi
chown dispatch:dispatch .env && chmod 600 .env

echo "==> systemd"
cp deploy/dispatch-staging.service /etc/systemd/system/dispatch-staging.service
systemctl daemon-reload
systemctl enable --now dispatch-staging

echo "==> caddy"
if ! grep -q "$DOMAIN" /etc/caddy/Caddyfile; then
  cat >> /etc/caddy/Caddyfile <<CADDY

# Staging: simulated drivers, test partner key. Everything goes to port 3001.
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3001
}
CADDY
  systemctl reload caddy
fi

echo "==> first back-office login for staging"
echo "   sudo -u dispatch bash -c 'cd $BASE/dispatch-service && set -a && . ./.env && set +a && node scripts/ops-user.js add --email you@feest.co.za --name \"Your Name\" --role admin'"

sleep 3
curl -fsS http://127.0.0.1:3001/health && echo && echo "Done. https://$DOMAIN/health should say \"env\":\"staging\""
