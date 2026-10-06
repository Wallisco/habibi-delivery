#!/usr/bin/env bash
# Road routing for billing: OSRM on South African OpenStreetMap data.
# Run as root on the dispatch server (Ubuntu 24.04), once. Re-run to refresh
# the map; a monthly refresh is installed in cron.
#
#   bash deploy/setup-osrm.sh            # build + run + point both envs at it
#   bash deploy/setup-osrm.sh --refresh  # rebuild with the latest map, then swap
#
# What it does
#   1. Installs Docker (OSRM's official image; nothing to compile).
#   2. Downloads South Africa from Geofabrik (~400 MB, includes Lesotho/Eswatini).
#   3. Builds the car graph with the MLD pipeline (extract, partition, customize).
#      Peak memory is roughly 6-8 GB: on a smaller server this adds swap first,
#      and the build takes longer. Running it afterwards needs about 2-3 GB.
#   4. Runs osrm-routed on 127.0.0.1:5000 only (never exposed), restarts on boot.
#   5. Sets OSRM_URL in production and staging .env and restarts them.
#
# Check afterwards: the back office Integration tab shows "osrm" and a count of
# road routes; /health shows "routing":"osrm".
set -euo pipefail

IMAGE=ghcr.io/project-osrm/osrm-backend:v5.27.1
PBF_URL=https://download.geofabrik.de/africa/south-africa-latest.osm.pbf
ROOT=/var/lib/osrm
NAME=osrm
REFRESH=${1:-}

echo "==> Docker"
if ! command -v docker >/dev/null; then
  apt-get update && apt-get install -y docker.io
  systemctl enable --now docker
fi

echo "==> memory"
MEM_GB=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo)
SWAP_GB=$(awk '/SwapTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo)
if [ $((MEM_GB + SWAP_GB)) -lt 9 ]; then
  echo "   ${MEM_GB} GB RAM + ${SWAP_GB} GB swap is tight for the build; adding an 8 GB swap file"
  if [ ! -f /swapfile-osrm ]; then
    fallocate -l 8G /swapfile-osrm && chmod 600 /swapfile-osrm && mkswap /swapfile-osrm
  fi
  swapon /swapfile-osrm 2>/dev/null || true
fi

BUILD="$ROOT/build-$(date +%Y%m%d)"
mkdir -p "$BUILD"
echo "==> map data -> $BUILD"
curl -fL --retry 3 -o "$BUILD/sa.osm.pbf" "$PBF_URL"

echo "==> build the graph (this is the slow part: 20-60 minutes)"
docker run --rm -v "$BUILD:/data" "$IMAGE" osrm-extract -p /opt/car.lua /data/sa.osm.pbf
docker run --rm -v "$BUILD:/data" "$IMAGE" osrm-partition /data/sa.osrm
docker run --rm -v "$BUILD:/data" "$IMAGE" osrm-customize /data/sa.osrm
rm -f "$BUILD/sa.osm.pbf"

echo "==> sanity check before switching"
docker rm -f "$NAME-check" >/dev/null 2>&1 || true
docker run -d --name "$NAME-check" -p 127.0.0.1:5001:5000 -v "$BUILD:/data" "$IMAGE" \
  osrm-routed --algorithm mld --max-table-size 1000 /data/sa.osrm >/dev/null
sleep 8
# Milnerton Galleria -> Loxton Rd, Milnerton: must be a real road route.
CHECK=$(curl -fsS "http://127.0.0.1:5001/route/v1/driving/18.5309754,-33.8329992;18.5311103,-33.832472?overview=false" || true)
docker rm -f "$NAME-check" >/dev/null
echo "$CHECK" | grep -q '"code":"Ok"' || { echo "!! test route failed, keeping the current map: $CHECK"; exit 1; }

echo "==> switch to the new graph"
ln -sfn "$BUILD" "$ROOT/current"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped -p 127.0.0.1:5000:5000 \
  -v "$ROOT/current:/data" "$IMAGE" osrm-routed --algorithm mld --max-table-size 1000 /data/sa.osrm >/dev/null
sleep 8
curl -fsS "http://127.0.0.1:5000/route/v1/driving/18.5309754,-33.8329992;18.5311103,-33.832472?overview=false" | grep -q '"code":"Ok"'

# Keep the previous build for a quick rollback; delete anything older.
ls -1dt "$ROOT"/build-* | tail -n +3 | xargs -r rm -rf

if [ "$REFRESH" != "--refresh" ]; then
  echo "==> point the dispatch service at OSRM"
  for ENVF in /opt/dispatch/dispatch-service/.env /opt/dispatch-staging/dispatch-service/.env; do
    [ -f "$ENVF" ] || continue
    if grep -q '^OSRM_URL=' "$ENVF"; then
      sed -i 's|^OSRM_URL=.*|OSRM_URL=http://127.0.0.1:5000|' "$ENVF"
    else
      echo 'OSRM_URL=http://127.0.0.1:5000' >> "$ENVF"
    fi
  done
  systemctl restart dispatch
  systemctl restart dispatch-staging 2>/dev/null || true

  echo "==> monthly map refresh (1st of the month, 03:30)"
  cp "$0" /usr/local/bin/osrm-refresh && chmod +x /usr/local/bin/osrm-refresh
  ( crontab -l 2>/dev/null | grep -v osrm-refresh; echo "30 3 1 * * /usr/local/bin/osrm-refresh --refresh >> /var/log/osrm-refresh.log 2>&1" ) | crontab -
fi

sleep 2
curl -fsS http://127.0.0.1:3000/health && echo
echo "Done. Road routing is live; /health should show \"routing\":\"osrm\"."
