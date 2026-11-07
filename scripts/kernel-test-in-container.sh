#!/usr/bin/env bash
# Rebuilds the throwaway kernel database, applies db/migrations/*.sql in order and runs db/tests.sh,
# so the suite always tests the real migrated schema. Runs inside the kernel-test container
# (scripts/db-test.sh calls it). Only point it at a cluster you can wipe: it drops the erp
# database and the erp_* roles.
#
# Same rules as the migration runner (packages/db/src/migrate): *.superuser.sql files run as the
# superuser; every other file runs under SET ROLE erp_owner. Each file is one transaction.
set -euo pipefail
cd "$(dirname "$0")/.."
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "DROP DATABASE IF EXISTS erp WITH (FORCE);" \
  -c "DROP ROLE IF EXISTS erp_scheduler;" -c "DROP ROLE IF EXISTS erp_app;" -c "DROP ROLE IF EXISTS erp_guard;" -c "DROP ROLE IF EXISTS erp_owner;" \
  -c "CREATE DATABASE erp;"
shopt -s nullglob
files=(db/migrations/*.sql)
[ ${#files[@]} -gt 0 ] || { echo "no migrations in db/migrations" >&2; exit 1; }
for f in "${files[@]}"; do   # glob order is lexical: 0001, 0002, ...
  echo "applying $f"
  case "$f" in
    *.superuser.sql) psql -X -q -v ON_ERROR_STOP=1 --single-transaction -U postgres -d erp -f "$f" ;;
    *) psql -X -q -v ON_ERROR_STOP=1 --single-transaction -U postgres -d erp -c 'SET LOCAL ROLE erp_owner' -f "$f" ;;
  esac
done
DB=erp bash db/tests.sh
