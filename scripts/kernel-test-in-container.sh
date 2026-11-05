#!/usr/bin/env bash
# Rebuilds the throwaway kernel database, loads db/schema.sql and runs db/tests.sh.
# Runs inside the kernel-test container (scripts/db-test.sh calls it). Only point it at a
# cluster you can wipe: it drops the erp database and the erp_* roles.
set -euo pipefail
cd "$(dirname "$0")/.."
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "DROP DATABASE IF EXISTS erp WITH (FORCE);" \
  -c "DROP ROLE IF EXISTS erp_app;" -c "DROP ROLE IF EXISTS erp_guard;" -c "DROP ROLE IF EXISTS erp_owner;" \
  -c "CREATE DATABASE erp;"
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d erp -f db/schema.sql
DB=erp bash db/tests.sh
