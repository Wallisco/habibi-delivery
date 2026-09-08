#!/usr/bin/env bash
# Nightly database backup. Install with:
#   sudo cp deploy/backup.sh /usr/local/bin/dispatch-backup
#   sudo chmod +x /usr/local/bin/dispatch-backup
#   sudo crontab -e   ->   15 2 * * * /usr/local/bin/dispatch-backup
set -euo pipefail

DB=/var/lib/dispatch/dispatch.db
DEST=/var/lib/dispatch/backups
KEEP_DAYS=30

mkdir -p "$DEST"
STAMP=$(date +%F-%H%M)

# .backup is safe on a live database; copying the file while WAL is active
# is not. This is the difference between a restorable backup and a corrupt one.
sqlite3 "$DB" ".backup '$DEST/dispatch-$STAMP.db'"
gzip -f "$DEST/dispatch-$STAMP.db"

find "$DEST" -name 'dispatch-*.db.gz' -mtime +$KEEP_DAYS -delete
echo "backed up to $DEST/dispatch-$STAMP.db.gz"
