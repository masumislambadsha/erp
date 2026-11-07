#!/bin/sh
# Lets the backup container take a base backup over a replication connection (scram password). Runs once, on a fresh data directory.
echo "host replication all all scram-sha-256" >> "$PGDATA/pg_hba.conf"
