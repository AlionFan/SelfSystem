#!/bin/sh
set -eu
umask 077
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BACKUP_PATH="$PROJECT_DIR/.local/backups"
mkdir -p "$BACKUP_PATH"
chmod 700 "$BACKUP_PATH"
temporary="$BACKUP_PATH/incoming-$$.tar.gz"
trap 'test ! -f "$temporary" || /bin/rm "$temporary"' EXIT
/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 joybeat 'sudo -n cat /data/joybeat-me/backups/latest.tar.gz' > "$temporary"
/usr/bin/tar -tzf "$temporary" >/dev/null
stamp=$(/bin/date -u +%Y-%m-%dT%H-%M-%SZ)
/bin/mv "$temporary" "$BACKUP_PATH/me-$stamp.tar.gz"
/bin/cp "$BACKUP_PATH/me-$stamp.tar.gz" "$BACKUP_PATH/latest.tar.gz"
chmod 600 "$BACKUP_PATH/latest.tar.gz"
/usr/bin/find "$BACKUP_PATH" -maxdepth 1 -type f -name 'me-*.tar.gz' -mtime +60 -delete
echo "Off-server backup verified: $stamp"
