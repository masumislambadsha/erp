# Operations: backups, restore, alerts

The hosting decision (D11) is still open, so everything here uses stock PostgreSQL tools and
Prometheus-format rules. It runs anywhere that gives you a superuser or a `REPLICATION` role.

## Point-in-time backups

PostgreSQL needs two things: a **base backup** now and then, and **every WAL segment** in between.

1. Turn on WAL archiving on the production server (`ops/postgresql-pitr.conf.example`).
   `archive_command` must copy a segment to storage that outlives the server (an S3-compatible bucket, per PLAN.md)
   and return non-zero on any failure. Encrypt at rest and in transit (PLAN.md, Security: "encrypted backups").
2. Take a base backup nightly: `PGHOST=... PGUSER=<replication role> BACKUP_DIR=/backups bash scripts/backup-base.sh`.
   It runs `pg_basebackup` and then `pg_verifybackup` against the backup's own checksums. Encrypt it and ship it with the WAL.
3. Keep base backups and the WAL between them for the recovery window you promise (start with 14 days).
4. Alert if archiving stalls: `pg_stat_archiver.failed_count` rising, or `last_archived_time` older than a few minutes.

## Restore

`bash scripts/restore-pitr.sh <base_backup_dir> <wal_archive_dir> "<timestamp>|latest" <new_data_dir> <port>`
restores into a **new** data directory (it refuses to overwrite one), replays WAL to the moment, and starts the server.
Point the application at the restored server only after checking it (below), and never restore over a live database.

## The restore drill

`bash scripts/restore-drill.sh` proves the above end to end on throwaway clusters: it applies the migrations, posts books
in three phases, takes a base backup after phase 1, restores to the moment after phase 2, and checks that the restored
trial balance equals the source's at that moment, that phase 3 is absent, and that the integrity check is clean.
CI runs it on every push. **Rehearse it against a real backup before Gate 0 and monthly after**, with
`scripts/restore-pitr.sh` into a scratch server and `SELECT * FROM trial_balance(<company>, <date>)` compared with production's.

## Alerts

`ops/alerts.yml` holds Prometheus alerting rules: error rate, p95 latency, failed jobs, stuck jobs, ledger-integrity
differences, a nightly check that did not run, sign-in spikes, and the API being down. The API serves metrics in
Prometheus format on `METRICS_HOST:METRICS_PORT` (default `127.0.0.1:9464`), so run a scraper beside it as job `erp-api`.
Traces go over OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. `apps/api/test/observability.int.test.ts` checks that
every metric named in the rules is really exported.

## Jobs (pg-boss)

The queue lives in the `pgboss` schema, installed by migration 0004 so that `erp_app` needs no DDL. `erp_app` cannot take
advisory locks (kernel test K08), so pg-boss runs with `supervise`, `schedule` and `migrate` off: the API enqueues the
nightly check at 02:00 Asia/Dhaka with a per-day singleton key, deletes finished jobs past retention every hour, and
reports jobs stuck past their expiry (alert `JobsStuck`). A stuck job needs a person: fail it in `pgboss.job`
and read the logs. A new queue needs a migration (`create_queue` is DDL).
