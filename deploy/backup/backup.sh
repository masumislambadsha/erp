#!/usr/bin/env bash
# Backups that outlive the server. Modes:
#   run      the service: ship WAL every minute, take a base backup at BASE_BACKUP_HOUR_UTC each day
#   base     one base backup now (the deploy script runs this before it migrates)
#   wal      ship pending WAL once
# Everything is encrypted with age to AGE_RECIPIENT (a public key; the private key stays with the owner, offline)
# before it leaves the server, then copied to S3_BUCKET at S3_ENDPOINT. With no recipient or bucket set it
# says so and does nothing, so a fresh server still starts.
set -euo pipefail
mode=${1:-run}
ready() { [ -n "${AGE_RECIPIENT:-}" ] && [ -n "${S3_BUCKET:-}" ] && [ -n "${AWS_ACCESS_KEY_ID:-}" ]; }
aws_s3() { aws ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"} s3 "$@"; }
log() { printf '{"ts":"%s","level":"%s","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$2"; }

ship_wal() {
  mkdir -p /wal/shipped
  for f in /wal/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    case "$name" in *.partial|*.tmp) continue ;; esac
    if age -r "$AGE_RECIPIENT" < "$f" | aws_s3 cp - "s3://$S3_BUCKET/wal/$name.age" --only-show-errors; then
      mv "$f" "/wal/shipped/$name"
    else
      log error "could not ship WAL $name"; return 1
    fi
  done
  find /wal/shipped -type f -mtime +2 -delete   # shipped segments are kept two days locally for a quick restore
}

base_backup() {
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' RETURN
  # Tar format with the WAL it needs streamed in: one self-consistent copy, restorable by itself.
  pg_basebackup -D "$dir" -Ft -z -X stream --checkpoint=fast --label="erp-$ts"
  tar -C "$dir" -cf - . | age -r "$AGE_RECIPIENT" | aws_s3 cp - "s3://$S3_BUCKET/base/base-$ts.tar.age" --only-show-errors
  size=$(aws_s3 ls "s3://$S3_BUCKET/base/base-$ts.tar.age" | awk '{print $3}')
  [ "${size:-0}" -gt 0 ] || { log error "base backup $ts uploaded empty"; return 1; }
  log info "base backup $ts uploaded ($size bytes)"
}

if ! ready; then
  log warn "backup is not configured (BACKUP_AGE_RECIPIENT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY, BACKUP_S3_SECRET_KEY): nothing is being shipped. WAL stays in the wal volume."
  [ "$mode" = run ] && exec sleep infinity
  exit "${REQUIRE_BACKUP:-0}"
fi

case "$mode" in
  wal) ship_wal ;;
  base) ship_wal; base_backup ;;
  run)
    last_base=""
    while true; do
      ship_wal || true
      today=$(date -u +%F)
      if [ "$(date -u +%H)" -ge "${BASE_BACKUP_HOUR_UTC:-20}" ] && [ "$last_base" != "$today" ]; then
        if base_backup; then last_base=$today; fi
      fi
      sleep 60
    done ;;
  *) echo "usage: backup.sh run|base|wal" >&2; exit 2 ;;
esac
