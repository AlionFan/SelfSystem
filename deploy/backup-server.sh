#!/bin/sh
set -eu
umask 077
ROOT=/data/joybeat-me
/usr/bin/docker exec me-c6zlqam9byswlqx825cse0bc node scripts/backup.mjs
mkdir -p "$ROOT/backups"
stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
temporary="$ROOT/backups/.me-$stamp.tar.gz"
tar -czf "$temporary" -C "$ROOT" data/backups config deployment-state.json -C /data/coolify/proxy dynamic/me.yaml me/client-ca.pem
chmod 600 "$temporary"
mv "$temporary" "$ROOT/backups/me-$stamp.tar.gz"
cp "$ROOT/backups/me-$stamp.tar.gz" "$ROOT/backups/latest.tar.gz.tmp"
mv "$ROOT/backups/latest.tar.gz.tmp" "$ROOT/backups/latest.tar.gz"
# Keep the latest 30 days; only files created by this backup job are eligible.
find "$ROOT/data/backups" -maxdepth 1 -type f -name 'me-*' -mtime +30 -delete
find "$ROOT/backups" -maxdepth 1 -type f -name 'me-*.tar.gz' -mtime +30 -delete
echo "Me backup completed: $stamp"
