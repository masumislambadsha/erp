import pg from 'pg';
import { uuidv7 } from './uuid7.js';

/** Permissions of the seeded roles. The catalog itself lives in the API; roles are data. */
export interface SeedRole {
  name: string;
  description: string;
  requiresTotp: boolean;
  permissions: string[];
}

export interface ProvisionInput {
  tenantName: string;
  tenantId?: string;
  adminEmail: string;
  adminName: string;
  /** An argon2id PHC string. Hashing happens in the API package; this one never sees a password. */
  adminPasswordHash: string;
  roles: SeedRole[];
  /** The role given to the first user. */
  adminRole: string;
}

export interface Provisioned {
  tenantId: string;
  adminUserId: string;
}

/**
 * Creates a tenant, its seeded roles and its first administrator. This is an operator tool, run
 * with the superuser connection (tenants are created by the platform, never by erp_app, which
 * can only read its own tenant row). It sets the same transaction context the app does, so the
 * audit trigger records who did it (the nil user: "the platform").
 */
export async function provisionTenant(
  adminUrl: string,
  input: ProvisionInput,
): Promise<Provisioned> {
  const tenantId = input.tenantId ?? uuidv7();
  const adminUserId = uuidv7();
  const nil = '00000000-0000-0000-0000-000000000000';
  const c = new pg.Client({ connectionString: adminUrl, application_name: 'erp-provision' });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [tenantId, nil],
    );
    await c.query('INSERT INTO tenant (id, name) VALUES ($1, $2)', [tenantId, input.tenantName]);
    await c.query("INSERT INTO currency_setting (tenant_id, id, code) VALUES ($1, $2, 'BDT')", [
      tenantId,
      uuidv7(),
    ]); // two places, half up (D17)
    const roleIds = new Map<string, string>();
    for (const r of input.roles) {
      const id = uuidv7();
      roleIds.set(r.name, id);
      await c.query(
        'INSERT INTO role (tenant_id, id, name, description, requires_totp, is_system) VALUES ($1,$2,$3,$4,$5,true)',
        [tenantId, id, r.name, r.description, r.requiresTotp],
      );
      for (const p of r.permissions) {
        await c.query(
          'INSERT INTO role_permission (tenant_id, id, role_id, permission) VALUES ($1,$2,$3,$4)',
          [tenantId, uuidv7(), id, p],
        );
      }
    }
    const adminRoleId = roleIds.get(input.adminRole);
    if (!adminRoleId) throw new Error(`no seeded role named ${input.adminRole}`);
    await c.query('INSERT INTO app_user (tenant_id, id, email, name) VALUES ($1,$2,$3,$4)', [
      tenantId,
      adminUserId,
      input.adminEmail.trim().toLowerCase(),
      input.adminName,
    ]);
    await c.query(
      'INSERT INTO user_credential (tenant_id, user_id, password_hash) VALUES ($1,$2,$3)',
      [tenantId, adminUserId, input.adminPasswordHash],
    );
    await c.query('INSERT INTO user_role (tenant_id, id, user_id, role_id) VALUES ($1,$2,$3,$4)', [
      tenantId,
      uuidv7(),
      adminUserId,
      adminRoleId,
    ]);
    await c.query('COMMIT');
    return { tenantId, adminUserId };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

export type PlatformQuery = (
  text: string,
  values?: unknown[],
) => Promise<Record<string, unknown>[]>;

/**
 * Runs operator setup for one tenant in one transaction, as the superuser, with the same context the app
 * sets (the nil user is "the platform"). For seeding a tenant's chart of accounts and posting setup.
 */
export async function withPlatform<T>(
  adminUrl: string,
  tenantId: string,
  fn: (q: PlatformQuery) => Promise<T>,
): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl, application_name: 'erp-platform' });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', '00000000-0000-0000-0000-000000000000', true)",
      [tenantId],
    );
    const out = await fn(async (text, values) => (await c.query(text, values)).rows);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}
