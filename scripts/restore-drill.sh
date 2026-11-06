#!/usr/bin/env bash
# The restore drill: proves a backup restores into a fresh cluster with a matching trial balance.
# It builds a throwaway source cluster with WAL archiving, applies db/migrations, posts books in three
# phases, takes a base backup between phases 1 and 2, restores to the moment after phase 2 (point in
# time, skipping phase 3), and compares the trial balance, row counts and the integrity check.
#   bash scripts/restore-drill.sh            (as a normal user, or root: it then re-runs itself as postgres)
# Needs PostgreSQL 16+ binaries (PG_BIN, or on PATH, or /usr/lib/postgresql/*/bin). Exit 0 = the drill passed.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

if [ "$(id -u)" = 0 ]; then   # initdb refuses root
  command -v su >/dev/null && id postgres >/dev/null 2>&1 || { echo "run as a non-root user" >&2; exit 2; }
  work=$(mktemp -d /tmp/erp-drill.XXXXXX); chmod 755 "$work"; chown postgres "$work"
  exec su postgres -c "DRILL_DIR='$work' PG_BIN='${PG_BIN:-}' bash '$ROOT/scripts/restore-drill.sh'"
fi

if [ -z "${PG_BIN:-}" ]; then
  if command -v initdb >/dev/null 2>&1; then PG_BIN=$(dirname "$(command -v initdb)")
  else PG_BIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1); fi
fi
[ -x "$PG_BIN/initdb" ] || { echo "no PostgreSQL binaries found (set PG_BIN)" >&2; exit 2; }
export PATH="$PG_BIN:$PATH"
WORK=${DRILL_DIR:-$(mktemp -d /tmp/erp-drill.XXXXXX)}
SRC=$WORK/source; ARCHIVE=$WORK/wal-archive; BACKUPS=$WORK/backups; RESTORED=$WORK/restored; SOCK=$WORK/sock; RSOCK=$WORK/rsock
SPORT=${DRILL_SOURCE_PORT:-55441}; RPORT=${DRILL_RESTORE_PORT:-55442}
mkdir -p "$ARCHIVE" "$BACKUPS" "$SOCK" "$RSOCK"
cleanup() { pg_ctl -D "$SRC" -m immediate stop >/dev/null 2>&1 || true; pg_ctl -D "$RESTORED" -m immediate stop >/dev/null 2>&1 || true; [ -n "${KEEP_DRILL:-}" ] || rm -rf "$WORK"; }
trap cleanup EXIT
step() { echo "== $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
sq() { psql -X -q -At -v ON_ERROR_STOP=1 -h "$SOCK" -p "$SPORT" -U postgres "$@"; }
rq() { psql -X -q -At -v ON_ERROR_STOP=1 -h "$RSOCK" -p "$RPORT" -U postgres "$@"; }

step "source cluster with WAL archiving"
initdb -D "$SRC" -A trust -U postgres >/dev/null
pg_ctl -D "$SRC" -w -l "$SRC/log" start -o "-p $SPORT -k $SOCK -c listen_addresses='' -c wal_level=replica -c archive_mode=on -c archive_timeout=5 -c archive_command='cp %p $ARCHIVE/%f'" >/dev/null
sq -d postgres -c "CREATE DATABASE erp"
for f in db/migrations/*.sql; do
  case "$f" in
    *.superuser.sql) sq -d erp --single-transaction -f "$f" >/dev/null ;;
    *) sq -d erp --single-transaction -c 'SET LOCAL ROLE erp_owner' -f "$f" >/dev/null ;;
  esac
done
sq -d erp -v phase=1 -f scripts/drill-seed.sql >/dev/null

step "base backup (between phase 1 and 2)"
BASE=$(PGHOST="$SOCK" PGPORT=$SPORT PGUSER=postgres BACKUP_DIR="$BACKUPS" bash scripts/backup-base.sh)
echo "backup: $BASE"

step "phase 2, then the moment to restore to"
sq -d erp -v phase=2 -f scripts/drill-seed.sql >/dev/null
sleep 1
TARGET=$(sq -d postgres -c "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")
sleep 2
sq -d erp -v phase=3 -f scripts/drill-seed.sql >/dev/null          # after the target: must NOT be restored
# Make sure the WAL holding phase 3 is in the archive, so the restore has to choose to stop before it.
LAST_WAL=$(sq -d postgres -c "SELECT pg_walfile_name(pg_current_wal_insert_lsn())")
sq -d postgres -c "SELECT pg_switch_wal()" >/dev/null
for _ in $(seq 1 60); do [ -e "$ARCHIVE/$LAST_WAL" ] && break; sleep 1; done
[ -e "$ARCHIVE/$LAST_WAL" ] || fail "the WAL segment $LAST_WAL was not archived"
echo "target: $TARGET"

# What the books said at the target, read from the source by time: phases 1 and 2 only.
phase12="SELECT md5(coalesce(string_agg(t.account_id || ':' || t.net, ',' ORDER BY t.account_id), '')) || ' ' || coalesce(sum(t.net), 0)::text
  FROM (SELECT g.account_id, sum(g.amount) AS net FROM gl_line g JOIN journal j ON j.tenant_id = g.tenant_id AND j.id = g.journal_id
         WHERE j.created_at <= '$TARGET'::timestamptz GROUP BY g.account_id) t"
WANT=$(sq -d erp -c "$phase12")
WANT_J=$(sq -d erp -c "SELECT count(*) FROM journal WHERE created_at <= '$TARGET'::timestamptz")
ALL_J=$(sq -d erp -c "SELECT count(*) FROM journal")
[ "$WANT_J" != "$ALL_J" ] || fail "drill setup: phase 3 should be after the target"

step "point-in-time restore into a fresh cluster"
bash scripts/restore-pitr.sh "$BASE" "$ARCHIVE" "$TARGET" "$RESTORED" "$RPORT" "$RSOCK"

step "compare"
fp="SELECT md5(coalesce(string_agg(t.account_id || ':' || t.net, ',' ORDER BY t.account_id), '')) || ' ' || coalesce(sum(t.net), 0)::text
      FROM (SELECT account_id, sum(amount) AS net FROM gl_line GROUP BY account_id) t"
GOT=$(rq -d erp -c "$fp")
GOT_J=$(rq -d erp -c "SELECT count(*) FROM journal")
echo "trial balance, source at target : $WANT"
echo "trial balance, restored         : $GOT"
echo "journals: want $WANT_J, restored $GOT_J (source now has $ALL_J)"
echo "  source   : $(sq -d erp -c "SELECT string_agg(to_char(created_at AT TIME ZONE 'UTC', 'HH24:MI:SS.US'), ' ' ORDER BY created_at) FROM journal")"
echo "  restored : $(rq -d erp -c "SELECT string_agg(to_char(created_at AT TIME ZONE 'UTC', 'HH24:MI:SS.US'), ' ' ORDER BY created_at) FROM journal")"
[ "$GOT" = "$WANT" ] || fail "the restored trial balance differs"
[ "$GOT_J" = "$WANT_J" ] || fail "the restored journal count differs"
# The trial balance function the application uses, for the drill tenant's company.
TB=$(rq -d erp -c "BEGIN; SELECT set_config('app.tenant_id','d0000000-0000-4000-8000-000000000001',true); SELECT count(*) || ' accounts, debits ' || sum(debit) || ' credits ' || sum(credit) FROM trial_balance('d0000000-0000-4000-8000-0000000000c1', '2026-12-31'); COMMIT;" | grep accounts)
echo "trial_balance(): $TB"
echo "$TB" | grep -q 'debits 3000.0000 credits 3000.0000' || fail "restored trial balance is not 3000 against 3000 (phases 1 and 2)"
# The books are still sound: the integrity check finds nothing in the restored copy.
DIFFS=$(rq -d erp -c "BEGIN; SELECT set_config('app.tenant_id','d0000000-0000-4000-8000-000000000001',true); SELECT count(*) FROM integrity_check(); COMMIT;" | grep -E '^[0-9]+$')
[ "$DIFFS" = 0 ] || fail "integrity check found $DIFFS difference(s) in the restored copy"
echo "PASS: the restore matches the trial balance at $TARGET, excludes later postings, and the integrity check is clean"
