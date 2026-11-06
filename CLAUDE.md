# ERP: working rules for Claude Code

## What this is

A ledger-first, multi-tenant ERP for Bangladeshi trading companies. Other industries arrive later as packs that never change the core. The full plan is `docs/PLAN.md`; the 172 features and their tiers are `docs/FEATURE_MAP.md`.

**Current phase: Phase 0 (Foundations), which ends at Gate 0.** Don't build anything from a later phase unless asked.

Read the docs on demand, not up front. `grep -n '^#' docs/PLAN.md` lists the sections; read only the ones the task needs. The ones you'll use most:

- Twelve rules the system never breaks
- Architecture and Stack decisions
- How posting works
- Ledger kernel schema
- Security, privacy and access control
- Testing strategy, and its Definition of done
- Roadmap, with its Exit gates

## Non-negotiables

1. **The schema is the source of truth.** `db/schema.sql` defines the ledger kernel and its database guards. Never weaken, drop or bypass a guard, trigger, policy or grant to make app code work. If a guard blocks you, the app is wrong. If the schema truly must change, propose the change with a new test showing the original attack still fails. All 119 tests in `db/tests.sh` must keep passing.
2. **One database role, one tenant per transaction.** The app connects only as `erp_app`: never a superuser, `erp_owner`, or any role with BYPASSRLS. Every transaction runs in READ COMMITTED with constraints deferred (the defaults), and its first statement is:
   `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true);`
   No query runs outside such a transaction.
3. **Ledgers are append-only.** Corrections are new rows: a reversal, an adjustment or a credit note. Never UPDATE or DELETE a posted row.
4. **Money is never a JS number.** Use decimal.js end to end, NUMERIC(19,4) for amounts and NUMERIC(19,6) for quantities.
5. **A posting is one transaction:** the journal plus every ledger row it needs. At COMMIT the database checks:
   - the journal balances;
   - each control account matches its subledger, per party and per item;
   - every stock move is valued;
   - no lock date is broken;
   - the document is in the right state.
6. **Every new tenant-owned table follows the tenancy rules:**
   - tenant_id leads its keys;
   - foreign keys include tenant_id, and company_id too when both rows belong to a company;
   - row-level security is enabled and forced, with a policy, so catalog test K01 still passes;
   - master data and documents get the audit trigger.
7. **The core never imports a pack.** Packs extend the core only through its declared extension points ("The contract" in PLAN.md). dependency-cruiser enforces this in CI.
8. **Migrations are forward-only SQL,** applied expand-then-contract. No ORM generates or pushes DDL for kernel tables.
9. **Definition of done** for every feature is the list under "Definition of done, for every feature" in PLAN.md.

## Stack (PLAN.md, "Stack decisions")

- **Monorepo:** pnpm workspaces, strict TypeScript.
- **apps/api:** NestJS modular monolith; REST with OpenAPI, Zod validation, and idempotency keys on writes.
- **apps/web:** Next.js App Router, TanStack Query and Table, shadcn/ui.
- **Database:** PostgreSQL 16+. Drizzle for typed CRUD on non-ledger tables; hand-written SQL for posting.
- **Jobs:** pg-boss.
- **Core types and IDs:** UUIDv7 for app-generated IDs; decimal.js for Money.
- **Auth:** server-side sessions in httpOnly cookies, argon2id passwords, TOTP.
- **Tests:** Vitest, with fast-check for property tests. Playwright and k6 come later.
- **Observability:** OpenTelemetry and structured logs.

Pin current stable versions. Ask before adding any dependency not listed here.

## Commands

- **Kernel tests** (Docker, throwaway database): `bash scripts/db-test.sh`. Expect `119 passed, 0 failed`.
  - On Windows PowerShell: `docker compose up -d --wait kernel-test; docker compose exec -T kernel-test bash /kit/scripts/kernel-test-in-container.sh`
- **No Docker** (for example in a cloud session):
  - Install PostgreSQL 16 and start a throwaway cluster. initdb must run as a non-root user, such as postgres.
  - Run `PGHOST=<socket dir> PGPORT=<port> bash scripts/kernel-test-in-container.sh`.
  - The script drops and recreates the `erp` database and the `erp_*` roles, so point it only at that throwaway cluster.
  - CI still runs the Docker route on every push.
- **Keep the kernel-test container separate from app data.** `schema.sql` creates cluster-wide roles (`erp_owner`, `erp_guard`, `erp_app`) and revokes the advisory-lock functions from PUBLIC. Never load it into a cluster that holds other databases. The app's dev database gets its own Postgres container.
- Add pnpm scripts here as the repo grows.

## How to work: autonomous mode

I don't relay messages between sessions. Work through the Phase 0 milestones on your own, in order, without waiting for my OK between steps:

1. **Plan the milestone** from its spec in PROMPT.md. Run the self-review checklist below on the plan and fix whatever fails. Don't wait for approval.
2. **Build it on its own branch,** in small commits. While iterating, run the narrowest tests that cover the change. Before opening the pull request, run the full kernel suite and all app tests.
3. **Open a pull request.** Its description gives what changed, the test results, the decisions you made, and anything in PLAN.md you think is wrong. Run the checklist again on the finished diff.
4. **Never merge it yourself.** I merge on GitHub, in order, with "Create a merge commit".
5. **Go straight on to the next milestone.** Branch from the previous milestone's branch and point its pull request at that branch, so you never wait for my merge. Before each milestone, fetch; if earlier pull requests were merged, rebase onto main.

**Stop and ask me, in one short message, only when:**
- a protected file must change: db/schema.sql, db/tests.sh, db/migrations/0001_kernel.superuser.sql, .github/workflows/kernel.yml, or this file's Non-negotiables;
- a decision is mine: product scope, money, legal, the hosting region, or anything that costs money or makes data public;
- CI stays red after three honest attempts. Never skip, delete or weaken a test to make it pass;
- Milestone 5 needs production: deploying waits for the hosting decision (D11 in PLAN.md);
- Gate 0 is reached: report each criterion as pass or fail with evidence, then stop.

Otherwise, make the call most consistent with PLAN.md and record it in the pull request's decisions.

**Keep context lean.** Grep the docs instead of reading them whole, and don't echo big files back. Don't spawn subagents.

**Never commit secrets;** commit only `.env.example`.

## Self-review checklist (every plan and every pull request)

- **Scope:** only the current milestone; nothing from a later phase or tier.
- **Database guards:** the protected files are unchanged. Any kernel change is a new migration with a test that fails without it. The kernel suite applies db/migrations in order, and all its tests pass.
- **Tenancy:** tenant and user come only from the authenticated session. The dev stub reads headers only when DEV_AUTH_STUB=true, and the API refuses to start with it on in production.
- **Database access:** app code connects only as erp_app and only through withTenant. Nothing exports a raw pool or client.
- **Migrations:** superuser-only files are named `*.superuser.sql`; every other migration runs under SET ROLE erp_owner; schema_migration has no grants to erp_app.
- **New tables:** tenant_id leads the keys; foreign keys carry company_id where both rows belong to a company; row-level security is forced, with a policy (K01 passes); master data and documents get the audit trigger.
- **Types:** money is decimal.js; ids are UUIDv7 from crypto randomness; business dates are in the company's time zone; instants are timestamptz.
- **Dependencies:** only the stack's, pinned, with pg (node-postgres) as the driver. Justify anything else in the pull request.
- **Done:** the items of PLAN.md's Definition of done that apply to this milestone.

## Phase 0 milestones

| # | Milestone | Done when |
| --- | --- | --- |
| M1 | Repo and kernel in CI | The monorepo builds. The kernel suite and app tests run green in CI. The API's database layer sets tenant and user context in every transaction, and an isolation test proves one tenant can't touch another's rows |
| M2 | Identity and access | Sign-in with argon2id; TOTP for admins and approvers; sessions you can revoke. Users, roles and permissions, deny by default, tested per role |
| M3 | Metadata and document engine | Entity, field, form and list definitions drive API validation and the UI. A document type defined only in metadata goes draft, submit, cancel and amend, with numbering, permissions and audit |
| M4 | Jobs, backups, observability | pg-boss jobs. A nightly ledger-integrity check. Point-in-time backups, and a restore drill that matches the trial balance. Logs, traces and alerts |
| M5 | Walking skeleton for tenant zero | A rent invoice for one room in my building goes through a receipt to the trial balance, running in production |

**Gate 0 (PLAN.md, "Exit gates") closes Phase 0.** All of these must hold:

- the metadata-only document runs end to end;
- the isolation suite passes on every table;
- a backup restores with a matching trial balance;
- the building's rent invoices, receipts and trial balance run in production.
