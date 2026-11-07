import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env, admin } from './helpers.js';

// The job supervisor's role (owner-approved exception to "one role"): what it may and may not touch.
const url = process.env.DATABASE_SCHEDULER_URL;
const run = url ? describe : describe.skip;
let s: pg.Client;
let su: pg.Client;

run('erp_scheduler', () => {
  beforeAll(async () => {
    s = new pg.Client({ connectionString: url });
    await s.connect();
    su = await admin();
  });
  afterAll(async () => {
    await s?.end();
    await su?.end();
  });

  it('is not a superuser, cannot bypass RLS, owns nothing', async () => {
    const { rows } = await su.query(
      "SELECT r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, (SELECT count(*)::int FROM pg_class WHERE relowner = r.oid) AS owned FROM pg_roles r WHERE rolname = 'erp_scheduler'",
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      owned: 0,
    });
  });

  it('reads the tenant registry and takes advisory locks', async () => {
    expect(
      (await s.query('SELECT count(*)::int n FROM platform_tenant')).rows[0].n,
    ).toBeGreaterThan(0);
    await s.query('SELECT pg_advisory_lock(727275)');
    await s.query('SELECT pg_advisory_unlock(727275)');
    expect((await s.query('SELECT pg_try_advisory_xact_lock(1) AS ok')).rows[0].ok).toBe(true);
  });

  it('uses the pgboss schema', async () => {
    await s.query('SELECT count(*) FROM pgboss.job');
    await s.query('SELECT pgboss.job_now()');
  });

  it.each([
    'party',
    'company',
    'account',
    'document',
    'journal',
    'gl_line',
    'app_user',
    'user_credential',
    'session',
    'audit_log',
    'tenant',
    'role',
    'idempotency_key',
    'integrity_run',
    'currency_setting',
    'journal_check',
    'stock_balance',
    'period_balance',
  ])('holds no privilege on %s, and a query fails', async (t) => {
    const { rows } = await su.query(
      "SELECT has_table_privilege('erp_scheduler', $1, 'SELECT') s, has_table_privilege('erp_scheduler', $1, 'INSERT') i, has_table_privilege('erp_scheduler', $1, 'UPDATE') u, has_table_privilege('erp_scheduler', $1, 'DELETE') d",
      [t],
    );
    expect(rows[0]).toEqual({ s: false, i: false, u: false, d: false });
    // Without a tenant context row-level security answers first; either way it reads nothing.
    await expect(s.query(`SELECT 1 FROM ${t} LIMIT 1`)).rejects.toThrow(
      /permission denied|app\.tenant_id/,
    );
  });

  it("holds privileges on exactly the pgboss schema, platform_tenant and public's USAGE", async () => {
    const { rows } =
      await su.query(`SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p','v') AND n.nspname NOT IN ('pg_catalog','information_schema','pgboss')
          AND has_table_privilege('erp_scheduler', c.oid, 'SELECT,INSERT,UPDATE,DELETE')`);
    expect(rows).toEqual([{ t: 'public.platform_tenant' }]);
  });

  it('cannot write the registry, create tables or read the migration record', async () => {
    await expect(s.query('DELETE FROM platform_tenant')).rejects.toThrow(/permission denied/);
    await expect(s.query('CREATE TABLE pgboss.sneaky (x int)')).rejects.toThrow(
      /permission denied/,
    );
    await expect(s.query('CREATE TABLE public.sneaky (x int)')).rejects.toThrow(
      /permission denied/,
    );
    await expect(s.query('SELECT * FROM erp_migrations.schema_migration')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('erp_app cannot read the registry or take advisory locks', async () => {
    const app = new pg.Client({ connectionString: env('DATABASE_URL') });
    await app.connect();
    try {
      await expect(app.query('SELECT 1 FROM platform_tenant')).rejects.toThrow(/permission denied/);
      await expect(app.query('SELECT pg_advisory_lock(1)')).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });
});
