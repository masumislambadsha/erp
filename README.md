# ERP starter kit

Everything Claude Code needs to start Phase 0 of the ERP plan.

| Path | What it is |
| --- | --- |
| `PROMPT.md` | The kickoff prompt for Claude Code, and one prompt per Phase 0 milestone |
| `CLAUDE.md` | Project rules Claude Code loads on every run: non-negotiables, stack, commands, milestones |
| `docs/PLAN.md` | The full plan, exported from the "ERP Master Plan" doc on 6 Nov 2026 |
| `docs/FEATURE_MAP.md` | All 172 features with their tiers |
| `db/schema.sql` | The ledger kernel: 29 tables and their database guards |
| `db/tests.sh` | 119 tests that attack the kernel |
| `db/test-output.txt` | The last full run: 119 passed |
| `docker-compose.yml`, `scripts/` | Run the kernel tests in a throwaway PostgreSQL 16 container |
| `.github/workflows/kernel.yml` | Runs the kernel tests in CI on every push |

## Start

1. Put this folder in a new git repo and push it to GitHub.
2. Install Docker. Bash is needed too: on Windows, use WSL or Git Bash.
3. Run `bash scripts/db-test.sh`. It should end with `119 passed, 0 failed`.
4. Open Claude Code in the folder and paste the kickoff prompt from `PROMPT.md`.

## The monorepo (Milestone 1)

| Path | What it is |
| --- | --- |
| `apps/api` | NestJS API: config, `/health`, request context, a database module that only uses `withTenant` |
| `apps/web` | Next.js App Router, a placeholder home page |
| `packages/db` | `withTenant`, Drizzle tables for master data, `Money`, `uuidv7`, the migration runner |
| `packages/config` | Shared strict tsconfig, ESLint and Prettier config |
| `db/migrations` | Forward-only SQL. `0001_kernel.superuser.sql` is `db/schema.sql` byte for byte |
| `packs/` | Industry packs. The core never imports from here (dependency-cruiser enforces it) |

### Run it

```bash
cp .env.example .env
docker compose up -d --wait dev-db      # its own Postgres 16, separate from kernel-test
pnpm install
pnpm db:setup                            # applies migrations as the superuser, sets the erp_app password
pnpm build && pnpm test && pnpm test:integration
pnpm --filter @erp/api start             # API on :3001
```

`bash scripts/db-test.sh` still runs the 119 kernel tests. It applies `db/migrations/*.sql` in order,
so the suite always tests the real migrated schema.

### Migrations and roles

- Files are `NNNN_name.sql`, applied in order, each in one transaction with the row that records it
  (`erp_migrations.schema_migration`: version, name, sha256). A changed file, a missing file, or a new file
  numbered below an applied one is refused. That table lives in its own schema, and `erp_app` has no grants on it.
- `*.superuser.sql` files run as the connecting superuser. Every other file runs under `SET ROLE erp_owner`,
  so new objects belong to `erp_owner`. A file that leaves that role is rejected and rolled back.
  Later migrations must `GRANT` what `erp_app` needs, and every new tenant-owned table follows the tenancy rules.
- The migrator uses `DATABASE_ADMIN_URL`, a superuser. The API uses only `DATABASE_URL`, which must name `erp_app`.

**Hosting note.** `0001` creates roles, revokes the advisory-lock functions in `pg_catalog` and changes function
owners, so it needs a real superuser. Managed PostgreSQL without one (Amazon RDS, Supabase, Neon) will likely
reject it. That affects the hosting decision in Phase 0: choose a host that gives a superuser (a VM or container
you run, or a managed service that offers one) before Milestone 5.

### Dev auth stub

Until Milestone 2 brings sessions, the API takes tenant and user from the `x-dev-tenant-id` and `x-dev-user-id`
headers only when `DEV_AUTH_STUB=true` and `NODE_ENV` is not `production`. The API refuses to start in production
with the stub on. Without it, every route except `/health` answers 401.

## Identity and access (Milestone 2)

- **Sign-in.** `POST /auth/sign-in {tenantId, email, password}`. The tenant is the realm being signed in to; it is
  trusted only for this call. Passwords are argon2id. Wrong password, unknown email and unknown tenant all answer
  the same 401. Five wrong passwords lock the account for 15 minutes.
- **Sessions.** Server-side rows. The cookie `erp_session=<tenantId>.<sessionId>.<secret>` is httpOnly and SameSite=Lax
  (Secure in production); only a SHA-256 of the secret is stored. The tenant in the cookie opens the transaction, and
  the session must exist inside it, so a forged tenant finds nothing. Idle limit 30 minutes, absolute limit 12 hours.
  Revocation takes effect on the next request. Mutating requests need the header `x-erp-csrf: 1`.
- **TOTP.** Roles with `requires_totp` (admin and approver are seeded that way) make a session read-only to
  `/auth/*` until `POST /auth/totp/enroll` then `POST /auth/totp/verify`. Secrets are AES-256-GCM encrypted with
  `TOTP_ENCRYPTION_KEY`, bound to tenant and user. A code works once; five wrong codes revoke the session and lock the account.
- **Permissions.** Deny by default: a role holds a permission only as a `role_permission` row, and a route with no
  `@Requires`, `@AllowPendingMfa` or `@Public` is refused. `apps/api/test/permissions.int.test.ts` lists every route and
  checks each seeded role against it. Record rules limit a role to some companies for an entity; field rules hide or
  lock a field. Roles add up: the most permissive rule across a user's roles wins.
- **Provisioning.** Tenants are created by an operator, not by the API:
  `PROVISION_ADMIN_PASSWORD=... pnpm --filter @erp/api provision "Tenant" admin@example.com "Admin"` (uses the superuser URL).

## Metadata and the document engine (Milestone 3)

A document type is defined only in metadata: `POST /meta/doc-types {docType, definition}` (permission `meta:manage`).
The definition (validated by `packages/meta`) lists fields (text, number, money, date, boolean, select, party), optional
lines, a numbering prefix, a form layout and a list layout, each label in English and Bangla. The same definition
drives API validation and the screens in `apps/web`. Field values live in the kernel's `document.ext`; lines in `document_line`.

- **Permissions** are `<doc_type>:<action>` for `read, create, update, submit, cancel, amend`. Creating a type grants them to the
  roles named in `grantTo` (default `admin`); any role can be given them through `/roles`.
- **Lifecycle**: `POST /documents/:type` makes a draft, `PATCH` edits it (optimistic `version`), `POST .../submit` validates it
  against the current definition and lets the database number and freeze it, `POST .../cancel`, `POST .../amend` (a new draft
  pointing back to the cancelled one, once). The database's guards decide what is allowed; the API reports their refusals as 409.
- **Numbering**: one `number_series` per company and type, advanced only inside submit, so a failed submit takes no number.
- **Idempotency**: every document write needs an `Idempotency-Key` header; a retry replays the first answer.
- **UI**: `apps/web` (Next.js) signs in (with TOTP), lists, creates, edits, submits, cancels and amends documents of any
  defined type. Run the API on :3001 and `pnpm --filter @erp/web dev`; the browser talks to `/api`, rewritten to the API.

## Jobs, backups, observability (Milestone 4)

- **Jobs.** pg-boss in the `pgboss` schema (migration 0004). A job is enqueued inside the transaction that causes it:
  submitting a document queues `document.submitted`, and a rolled-back submit leaves no job. Workers run in the API process.
- **Nightly integrity check** at 02:00 Asia/Dhaka: `integrity_check()` rebuilds stock balances, open-item remainders,
  journal sums and closed-period totals from the ledgers and compares them with the stored values, per tenant. Each run is
  filed in `integrity_run`; any difference logs at error level and sets the `erp_integrity_differences` gauge. The job
  visits tenants through `platform_tenant`, a table of tenant ids (migration 0005).
- **Trial balance.** `SELECT * FROM trial_balance(<company>, <date>)` nets every account's GL lines.
- **Backups and restore drill.** `scripts/backup-base.sh`, `scripts/restore-pitr.sh`, `scripts/restore-drill.sh`; see `ops/README.md`.
- **Observability.** Structured JSON logs with request, trace, tenant and user ids; OpenTelemetry traces and metrics;
  `ops/alerts.yml` (Prometheus rules) for errors, latency, failed and stuck jobs and integrity differences.
- **Migrations 0004 and 0005 are `*.superuser.sql`**: 0004 because `CREATE SCHEMA` needs a database-level privilege,
  0005 because it backfills the tenant registry from rows the forced policy hides from non-superusers.

## Walking skeleton for tenant zero (Milestone 5)

The rental building as a tenant, using the kernel exactly as it is.

- `pnpm --filter @erp/api tenant-zero "Building" me@example.com "My Name"` (with `DATABASE_ADMIN_URL` and
  `PROVISION_ADMIN_PASSWORD`) creates the tenant, a company, three accounts (cash, rent receivable, rent income), the
  posting setup that names them by event (`receivable`, `revenue`, `cash`), the `rent_invoice` and `rent_receipt` document types
  (ordinary metadata), and the roles: `admin` (everything, TOTP) and `rent_clerk` (drafts only).
- **Rent invoice** submit posts: Dr rent receivable (renter), Cr rent income, with an open item. **Rent receipt** submit
  posts: Dr cash, Cr receivable (renter), with an open item that settles the invoice's. Both run inside the submit
  transaction through `PostingService`, the only writer of ledgers; the database checks the journal at COMMIT.
- **Cancel** posts a mirror journal dated on the document's own date, unapplying settlements first. A document
  settled by another cannot be cancelled until that one is.
- `GET /reports/trial-balance?companyId=&asOf=` (permission `report:read`) and the screen at `/reports/trial-balance`.
- Ledger partitions exist for 2026 and 2027. Run `pnpm db:ensure-partitions` yearly; the `LedgerPartitionMissing` alert fires if one is missing.
- Deploying to production waits for the hosting decision (D11).

## Hardening and hosting prep (after Gate 0)

- **Merging.** Pull requests are merged by Claude Code under the rules in CLAUDE.md (every GitHub check green, a merge commit, no protected file changed without the owner's OK).
- **Job supervisor role.** `erp_scheduler` (migration 0006, owner-approved amendment of Non-negotiable 2) runs pg-boss supervision and cron, so
  stuck jobs recover and the nightly check is scheduled at 02:00 Asia/Dhaka. It can read `platform_tenant` and use the `pgboss` schema and advisory locks,
  and nothing else; `erp_app` can no longer read the tenant registry. The nightly job fans out one `integrity.tenant` job per tenant; workers run them as `erp_app`.
- **Partitions.** `pnpm db:setup` and every deploy run `ensure-partitions` (this year through two years ahead); the supervisor alerts (`LedgerPartitionMissing`) if next year's are missing.
- **Rate limits.** Per signed-in user (300 a minute) and per client IP on sign-in (10 a minute), both settable (`RATE_LIMIT_*`); set `TRUST_PROXY=1` behind Caddy.
- **OpenAPI.** `GET /openapi.json`, committed as `docs/openapi.json` (a test fails if it is stale: `pnpm --filter @erp/api openapi`).
- **Rounding (D17).** Posted lines round to the currency's minor unit, half up by default; the mode is a row in `currency_setting`.
- **Isolation over every table.** `apps/api/test/isolation-all-tables.int.test.ts` seeds tenant A in every table that has `tenant_id` and proves, as `erp_app` in tenant B, that nothing of A can be read, changed, deleted or inserted.
- **Hosting.** `deploy/README.md` (one VPS, Docker Compose, encrypted backups to S3), `.github/workflows/deploy.yml`, `scripts/latency-test.sh`.
