#!/usr/bin/env bash
# One-time server provisioning. Run as root on a fresh Ubuntu 24.04 box.
#   bash setup-server.sh https://github.com/YOURNAME/YOURREPO.git api.yourdomain.co.za
set -euo pipefail

REPO="${1:?usage: setup-server.sh <git-repo-url> <api-domain>}"
DOMAIN="${2:?usage: setup-server.sh <git-repo-url> <api-domain>}"

echo "==> Node 22"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git sqlite3 ufw

echo "==> Caddy"
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

echo "==> service account and data directory"
id -u dispatch >/dev/null 2>&1 || adduser --system --group --home /opt/dispatch dispatch
mkdir -p /var/lib/dispatch/backups
chown -R dispatch:dispatch /var/lib/dispatch

echo "==> code"
if [ ! -d /opt/dispatch/.git ]; then
  git clone "$REPO" /opt/dispatch
fi
chown -R dispatch:dispatch /opt/dispatch
cd /opt/dispatch/dispatch-service
sudo -u dispatch npm install --omit=dev

echo "==> environment"
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|https://api.yourdomain.co.za|https://$DOMAIN|" .env
  echo "!! Edit /opt/dispatch/dispatch-service/.env before going live"
fi
chown dispatch:dispatch .env && chmod 600 .env

echo "==> systemd"
cp deploy/dispatch.service /etc/systemd/system/dispatch.service
systemctl daemon-reload
systemctl enable --now dispatch

echo "==> caddy"
sed "s|api.yourdomain.co.za|$DOMAIN|" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy

echo "==> firewall"
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

echo "==> backups"
cp deploy/backup.sh /usr/local/bin/dispatch-backup && chmod +x /usr/local/bin/dispatch-backup
( crontab -l 2>/dev/null; echo "15 2 * * * /usr/local/bin/dispatch-backup" ) | crontab -

sleep 3
curl -fsS http://127.0.0.1:3000/health && echo && echo "Done. https://$DOMAIN/ops"
