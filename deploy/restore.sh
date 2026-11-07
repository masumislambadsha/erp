#!/usr/bin/env bash
# Restores production's encrypted backups from S3-compatible storage into a NEW local PostgreSQL 16 (a recovery machine
# or a scratch box: never over the live database). Needs aws, age, tar and PostgreSQL 16 binaries, and the age PRIVATE key.
#   deploy/restore.sh --identity key.txt --bucket NAME [--endpoint URL] --base base-20261107T200000Z.tar.age \
#                     --target "2026-11-08 09:30:00+00" --data /var/lib/pgrestore --port 5440
# --target may be "latest". List what exists with: aws s3 ls s3://NAME/base/ [--endpoint-url URL]
set -euo pipefail
while [ $# -gt 0 ]; do case "$1" in
  --identity) identity=$2; shift 2 ;; --bucket) bucket=$2; shift 2 ;; --endpoint) endpoint=$2; shift 2 ;;
  --base) base=$2; shift 2 ;; --target) target=$2; shift 2 ;; --data) data=$2; shift 2 ;; --port) port=$2; shift 2 ;;
  *) echo "unknown option $1" >&2; exit 2 ;; esac; done
: "${identity:?}" "${bucket:?}" "${base:?}" "${target:?}" "${data:?}" "${port:?}"
s3() { aws ${endpoint:+--endpoint-url "$endpoint"} s3 "$@"; }
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
mkdir -p "$work/base" "$work/wal"
echo "== base backup $base"
s3 cp "s3://$bucket/base/$base" - --only-show-errors | age -d -i "$identity" | tar -C "$work/base" -xf -
mkdir -p "$work/plain/pg_wal"
tar -C "$work/plain" -xzf "$work/base/base.tar.gz"
tar -C "$work/plain/pg_wal" -xzf "$work/base/pg_wal.tar.gz"
echo "== archived WAL"
s3 ls "s3://$bucket/wal/" | awk '{print $4}' | while read -r f; do
  [ -n "$f" ] && s3 cp "s3://$bucket/wal/$f" - --only-show-errors | age -d -i "$identity" > "$work/wal/${f%.age}"
done
echo "== recover to $target"
bash "$(dirname "$0")/../scripts/restore-pitr.sh" "$work/plain" "$work/wal" "$target" "$data" "$port" "$data"
echo "Check it: psql -h $data -p $port -U postgres erp -c 'SELECT * FROM integrity_check()'  and compare trial_balance() with production's."
