# Prompts for Claude Code

## Standing prompt

Send this to start or resume any Claude Code session:

```text
Pull main, read CLAUDE.md, and work in autonomous mode through the Phase 0 milestones until Gate 0 or a stop condition.
```

The sections below are the milestone specs Claude Code works from. You don't need to paste them. Milestones 1 to 5 are merged (pull requests #1 to #5).

## Kickoff: Milestone 1

```text
You're starting the build of the ERP described in this repo. Before writing any code:

1. Read CLAUDE.md fully. Then run `grep -n '^#' docs/PLAN.md` and read only these sections:
   - Twelve rules the system never breaks
   - Architecture and Stack decisions
   - Ledger kernel schema
   - Security, privacy and access control
   - Testing strategy
   - Roadmap: Phase 0 and Gate 0
   Don't open docs/FEATURE_MAP.md yet.
2. Run the kernel tests and confirm "119 passed, 0 failed": use `bash scripts/db-test.sh` if
   Docker works, otherwise the no-Docker route in CLAUDE.md. Don't work around the tests.

Then plan Milestone 1 (Repo and kernel in CI).
Milestone 1 must deliver:

- A pnpm monorepo:
  - apps/api (NestJS) and apps/web (Next.js, placeholder home page)
  - packages/db
  - packages/config (shared strict tsconfig, ESLint, Prettier)
  - a dependency-cruiser rule: core code may never import from packs/
- Migrations:
  - db/schema.sql becomes migration 0001, byte for byte
  - a small forward-only SQL migration runner that records each applied file with a checksum
    and refuses a changed one
- A dev database in its own Postgres 16 container, separate from kernel-test.
  erp_app gets a dev-only password from .env; .env.example documents it.
- packages/db:
  - withTenant(tenantId, userId, fn): opens a READ COMMITTED transaction, sets app.tenant_id
    and app.user_id as its first statement, and makes any query outside it fail
  - Drizzle table definitions for the master-data tables, mirroring schema.sql.
    No drizzle-kit push or generate for kernel tables.
  - a Money type on decimal.js and a UUIDv7 helper, each with unit tests
- apps/api:
  - config and a health endpoint
  - a request context carrying tenant and user (stubbed until Milestone 2)
  - a database module that only ever uses withTenant
- Tests:
  - an integration test proving tenant A can't read or write tenant B's rows through the API
    layer
  - a test proving a query outside withTenant fails
- CI (GitHub Actions): lint, typecheck, unit and integration tests, and the kernel suite.
  .github/workflows/kernel.yml already runs the kernel suite; keep it.

Done when CI is green and both test suites pass locally. Push your branch and open a pull request
that reports:
- the tree
- the test results
- the decisions you made
- anything in docs/PLAN.md you think is wrong
```

## Milestone 2: Identity and access

```text
Plan Milestone 2 (Identity and access) from CLAUDE.md.
Use the Feature map rows "Sign-in and two-factor" and "Users, roles and permissions", plus the
Auth row of Stack decisions:
- server-side sessions in httpOnly cookies, argon2id passwords, TOTP, session revocation
- deny-by-default permissions, record rules and field rules
- every permission tested per role
- the request context now takes tenant and user from the session
```

## Milestone 3: Metadata and document engine

```text
Plan Milestone 3 (Metadata and document engine). Use the Feature map rows
"Metadata engine", "Document engine" and "Audit trail", and PLAN.md's "The submit pipeline".

Done when a document type defined only in metadata goes draft, submit, cancel and amend through
the API and a basic UI, with:
- numbering from number_series
- permissions
- audit

The database already enforces the lifecycle: drafts at insert, number at submit, no edits after
submit. Build on it; don't duplicate it.
```

## Milestone 4: Jobs, backups, observability

```text
Plan Milestone 4 (Jobs, backups, observability):
- pg-boss jobs enqueued inside the posting transaction
- a nightly ledger-integrity job that rebuilds stock_balance and period totals from the ledgers
  and alerts on any difference
- point-in-time backups, and a restore drill script that compares trial balances
- OpenTelemetry traces and metrics with structured logs, and alerts on errors, latency and
  failed jobs
```

## Milestone 5: Walking skeleton and Gate 0

```text
Plan Milestone 5 (Walking skeleton for tenant zero). The tenant is my rental
building. One room's rent invoice must reach the trial balance:
- the invoice posts an open item and revenue
- a receipt posts cash and settles the invoice
- the trial balance shows both
Use the kernel exactly as it is. Stop before deploying: production waits for the hosting decision.

Then check every Gate 0 criterion in PLAN.md's "Exit gates". Report each one as pass or fail,
with evidence.
```
