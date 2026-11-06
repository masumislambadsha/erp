import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, uuidv7, type Db } from '../src/index.js';
import { provisionTenant } from '../src/admin.js';
import { admin, env } from './helpers.js';

let db: Db;
let su: pg.Client;
let A: { tenantId: string; adminUserId: string };
let B: { tenantId: string; adminUserId: string };
const roles = [{ name: 'admin', description: '', requiresTotp: true, permissions: ['user:read'] }];

const seed = (name: string) =>
  provisionTenant(env('DATABASE_ADMIN_URL'), {
    tenantName: name,
    adminEmail: `${uuidv7()}@example.test`,
    adminName: 'Admin',
    adminPasswordHash: '$argon2id$not-a-real-hash',
    roles,
    adminRole: 'admin',
  });

beforeAll(async () => {
  db = createDb({ connectionString: env('DATABASE_URL'), max: 3 });
  su = await admin();
  A = await seed('Identity A');
  B = await seed('Identity B');
});
afterAll(async () => {
  await db.end();
  await su.end();
});

const TABLES = [
  'app_user',
  'user_credential',
  'role',
  'role_permission',
  'user_role',
  'role_record_rule',
  'role_field_rule',
  'session',
  'auth_event',
];

describe('identity tables follow the tenancy rules', () => {
  it.each(TABLES)('%s: forced RLS with a policy', async (t) => {
    const { rows } = await su.query(
      `SELECT c.relrowsecurity rls, c.relforcerowsecurity forced, EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid) policy,
              pg_get_userbyid(c.relowner) owner
         FROM pg_class c WHERE c.oid = $1::regclass`,
      [t],
    );
    expect(rows[0]).toEqual({ rls: true, forced: true, policy: true, owner: 'erp_owner' });
  });

  it.each([
    'app_user',
    'role',
    'role_permission',
    'user_role',
    'role_record_rule',
    'role_field_rule',
  ])('%s has the audit trigger', async (t) => {
    const { rowCount } = await su.query(
      "SELECT 1 FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = 'audit'",
      [t],
    );
    expect(rowCount).toBe(1);
  });

  it('secrets are not audited: user_credential has no audit trigger', async () => {
    expect(
      (
        await su.query(
          "SELECT 1 FROM pg_trigger WHERE tgrelid = 'user_credential'::regclass AND tgname = 'audit'",
        )
      ).rowCount,
    ).toBe(0);
    const { rows } = await su.query(
      "SELECT count(*)::int n FROM audit_log WHERE tenant_id = $1 AND (entity = 'user_credential' OR changes::text LIKE '%argon2%')",
      [A.tenantId],
    );
    expect(rows[0].n).toBe(0);
  });

  it.each(TABLES.filter((t) => t !== 'auth_event'))(
    '%s: tenant A sees none of tenant B’s rows',
    async (t) => {
      const seen = await db.withTenant(A.tenantId, A.adminUserId, (tx) =>
        tx.query(`SELECT DISTINCT tenant_id FROM ${t}`),
      );
      expect(seen.every((r) => r.tenant_id === A.tenantId)).toBe(true);
    },
  );

  it('tenant A cannot write into tenant B or attach B’s role to its own user', async () => {
    await expect(
      db.withTenant(A.tenantId, A.adminUserId, (tx) =>
        tx.query('INSERT INTO role (tenant_id, id, name) VALUES ($1, $2, $3)', [
          B.tenantId,
          uuidv7(),
          'planted',
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    const bRole = (await su.query('SELECT id FROM role WHERE tenant_id = $1', [B.tenantId])).rows[0]
      .id;
    await expect(
      su.query('INSERT INTO user_role (tenant_id, id, user_id, role_id) VALUES ($1, $2, $3, $4)', [
        A.tenantId,
        uuidv7(),
        A.adminUserId,
        bRole,
      ]),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('privileges', () => {
  it('erp_app can revoke a session but not change its secret or lifetime', async () => {
    const id = uuidv7();
    await su.query('BEGIN');
    await su.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $1, true)",
      [A.tenantId],
    );
    await su.query(
      "INSERT INTO session (tenant_id, id, user_id, secret_hash, expires_at) VALUES ($1,$2,$3,'\\x00', now() + interval '1 hour')",
      [A.tenantId, id, A.adminUserId],
    );
    await su.query('COMMIT');
    const run = (sql: string) =>
      db.withTenant(A.tenantId, A.adminUserId, (tx) => tx.query(sql, [id]));
    await expect(run("UPDATE session SET secret_hash = '\\x01' WHERE id = $1")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      run("UPDATE session SET expires_at = now() + interval '99 years' WHERE id = $1"),
    ).rejects.toThrow(/permission denied/);
    await expect(run('DELETE FROM session WHERE id = $1')).rejects.toThrow(/permission denied/);
    await run('UPDATE session SET revoked_at = now() WHERE id = $1');
  });

  it('auth_event is append-only, even for the superuser', async () => {
    await db.withTenant(A.tenantId, A.adminUserId, (tx) =>
      tx.query("INSERT INTO auth_event (tenant_id, user_id, kind) VALUES ($1, $2, 'test')", [
        A.tenantId,
        A.adminUserId,
      ]),
    );
    await expect(
      su.query("UPDATE auth_event SET kind = 'x' WHERE tenant_id = $1", [A.tenantId]),
    ).rejects.toThrow(/append-only|not allowed|rejected/i);
    await expect(
      su.query('DELETE FROM auth_event WHERE tenant_id = $1', [A.tenantId]),
    ).rejects.toThrow();
    await expect(
      db.withTenant(A.tenantId, A.adminUserId, (tx) =>
        tx.query("UPDATE auth_event SET kind = 'x'"),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('erp_app cannot delete users or read the migration record', async () => {
    await expect(
      db.withTenant(A.tenantId, A.adminUserId, (tx) => tx.query('DELETE FROM app_user')),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.withTenant(A.tenantId, A.adminUserId, (tx) =>
        tx.query('SELECT * FROM erp_migrations.schema_migration'),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('audit', () => {
  it('records who changed a role’s permissions, in the same transaction', async () => {
    const actor = A.adminUserId;
    const roleId = (await su.query('SELECT id FROM role WHERE tenant_id = $1', [A.tenantId]))
      .rows[0].id;
    const permId = uuidv7();
    await db.withTenant(A.tenantId, actor, (tx) =>
      tx.query(
        "INSERT INTO role_permission (tenant_id, id, role_id, permission) VALUES ($1,$2,$3,'audit:read')",
        [A.tenantId, permId, roleId],
      ),
    );
    const { rows } = await su.query(
      "SELECT actor_id, action, changes FROM audit_log WHERE entity = 'role_permission' AND entity_id = $1",
      [permId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(actor);
    expect(rows[0].action).toBe('insert');
    expect(rows[0].changes.permission).toEqual([null, 'audit:read']);
  });
});
