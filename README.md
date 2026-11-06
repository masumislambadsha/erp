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
