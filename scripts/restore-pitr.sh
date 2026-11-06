#!/usr/bin/env bash
# Restores a base backup into a NEW data directory, replays archived WAL up to a moment, and starts it.
#   bash scripts/restore-pitr.sh <base_backup_dir> <wal_archive_dir> <target_time|latest> <new_data_dir> <port> [socket_dir]
# target_time is a timestamp such as "2026-11-06 14:30:00+00". Run as the postgres user (not root).
set -euo pipefail
base=${1:?base backup dir}; archive=${2:?WAL archive dir}; target=${3:?target time or latest}; data=${4:?new data dir}; port=${5:?port}
sock=${6:-$data}
PG_BIN="${PG_BIN:-}"
pgb() { if [ -n "$PG_BIN" ]; then echo "$PG_BIN/$1"; else echo "$1"; fi; }
[ ! -e "$data" ] || { echo "refusing to restore over an existing $data" >&2; exit 1; }
cp -a "$base" "$data"
chmod 700 "$data"
rm -f "$data/postmaster.pid" "$data/backup_label.old"
{
  echo "restore_command = 'cp \"$archive/%f\" \"%p\"'"
  if [ "$target" != latest ]; then
    echo "recovery_target_time = '$target'"
    echo "recovery_target_action = 'promote'"
  fi
  echo "port = $port"
  echo "unix_socket_directories = '$sock'"
  echo "listen_addresses = ''"
  echo "archive_mode = off"
} >> "$data/postgresql.auto.conf"
touch "$data/recovery.signal"
"$(pgb pg_ctl)" -D "$data" -l "$data/restore.log" -w -t 300 start >/dev/null
# Recovery has finished when the server is no longer in recovery.
for _ in $(seq 1 120); do
  state=$("$(pgb psql)" -X -At -h "$sock" -p "$port" -U postgres -d postgres -c 'SELECT pg_is_in_recovery()' 2>/dev/null || echo t)
  [ "$state" = f ] && { echo "restored: $data (port $port)"; exit 0; }
  sleep 1
done
echo "recovery did not finish; see $data/restore.log" >&2
exit 1
