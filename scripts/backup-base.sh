#!/usr/bin/env bash
# Takes a verified base backup. Together with the archived WAL it allows point-in-time recovery.
#   PGHOST=... PGPORT=... PGUSER=<superuser or a REPLICATION role> BACKUP_DIR=/backups bash scripts/backup-base.sh
# Prints the backup's directory. Encrypt and ship it to object storage afterwards (ops/README.md).
set -euo pipefail
: "${BACKUP_DIR:?set BACKUP_DIR}"
PG_BIN="${PG_BIN:-}"
pgb() { if [ -n "$PG_BIN" ]; then echo "$PG_BIN/$1"; else echo "$1"; fi; }
dest="$BACKUP_DIR/base-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
# -X stream: the WAL needed to make this copy consistent travels with it. Later WAL comes from the archive.
"$(pgb pg_basebackup)" -D "$dest" -Fp -X stream --checkpoint=fast --label="erp-$(date -u +%Y%m%dT%H%M%SZ)"
"$(pgb pg_verifybackup)" "$dest" >&2      # checksums every file against the backup manifest
echo "$dest"
