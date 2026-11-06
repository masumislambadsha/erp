import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { uuidv7 } from '@erp/db';
import { provisionTenant } from '@erp/db/admin';
import { SEED_ROLES } from '../src/authz/permissions.js';
import { createApp } from '../src/create-app.js';
import { hashPassword } from '../src/security/password.js';
import { base32Decode, codeAtStep, stepAt } from '../src/security/totp.js';

export const DATABASE_URL = process.env.DATABASE_URL!;
export const ADMIN_URL = process.env.DATABASE_ADMIN_URL!;
export const TOTP_KEY = process.env.TOTP_ENCRYPTION_KEY!;
export const NIL = '00000000-0000-0000-0000-000000000000';
export const PASSWORD = 'correct-horse-battery-1';

export async function startApp(
  extra: Record<string, string> = {},
): Promise<{ app: INestApplication; base: string }> {
  const { app } = await createApp({
    DATABASE_URL,
    TOTP_ENCRYPTION_KEY: TOTP_KEY,
    NODE_ENV: 'test',
    DEV_AUTH_STUB: 'true',
    ...extra,
  });
  await app.listen(0);
  return { app, base: (await app.getUrl()).replace('[::1]', 'localhost') };
}

export async function superuser(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  return c;
}

export async function newTenant(
  name: string,
): Promise<{ tenantId: string; adminId: string; adminEmail: string }> {
  const adminEmail = `admin-${uuidv7()}@example.test`;
  const r = await provisionTenant(ADMIN_URL, {
    tenantName: name,
    adminEmail,
    adminName: 'Admin',
    adminPasswordHash: await hashPassword(PASSWORD),
    roles: SEED_ROLES,
    adminRole: 'admin',
  });
  return { tenantId: r.tenantId, adminId: r.adminUserId, adminEmail };
}

/** Adds a user holding the named roles, as the platform would (superuser, with the audit context set). */
export async function addUser(
  su: pg.Client,
  tenantId: string,
  roles: string[],
  email = `u-${uuidv7()}@example.test`,
): Promise<{ id: string; email: string }> {
  const id = uuidv7();
  const hash = await hashPassword(PASSWORD);
  await su.query('BEGIN');
  try {
    await su.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [tenantId, NIL],
    );
    await su.query('INSERT INTO app_user (tenant_id, id, email, name) VALUES ($1,$2,$3,$4)', [
      tenantId,
      id,
      email,
      'Test user',
    ]);
    await su.query(
      'INSERT INTO user_credential (tenant_id, user_id, password_hash) VALUES ($1,$2,$3)',
      [tenantId, id, hash],
    );
    for (const r of roles) {
      await su.query(
        'INSERT INTO user_role (tenant_id, id, user_id, role_id) SELECT $1, $2, $3, id FROM role WHERE tenant_id = $1 AND name = $4',
        [tenantId, uuidv7(), id, r],
      );
    }
    await su.query('COMMIT');
  } catch (e) {
    await su.query('ROLLBACK');
    throw e;
  }
  return { id, email };
}

export const stubHeaders = (tenant: string, user: string) => ({
  'x-dev-tenant-id': tenant,
  'x-dev-user-id': user,
  'content-type': 'application/json',
});

export interface Reply {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers;
}

export async function call(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Reply> {
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

/** A browser-like client: keeps the session cookie and sends the CSRF header. */
export class Browser {
  cookie = '';
  constructor(readonly base: string) {}
  async send(
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<Reply> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-erp-csrf': '1',
      ...extra,
    };
    if (this.cookie) headers.cookie = this.cookie;
    const r = await call(this.base, method, path, headers, body);
    const set = r.headers.getSetCookie?.()[0];
    if (set) this.cookie = set.startsWith('erp_session=;') ? '' : set.split(';')[0]!;
    return r;
  }
  signIn(tenantId: string, email: string, password = PASSWORD) {
    return this.send('POST', '/auth/sign-in', { tenantId, email, password });
  }
}

export function codeFor(base32Secret: string, stepOffset = 0): string {
  return codeAtStep(base32Decode(base32Secret), stepAt(Date.now()) + stepOffset);
}

/** Lets a test reuse a code window: forgets the last accepted step. */
export async function resetTotpReplay(su: pg.Client, userId: string): Promise<void> {
  await su.query('UPDATE user_credential SET totp_last_step = NULL WHERE user_id = $1', [userId]);
}

/** Runs SQL as the platform with the audit context the app would set. */
export async function asPlatform(
  su: pg.Client,
  tenantId: string,
  fn: () => Promise<void>,
): Promise<void> {
  await su.query('BEGIN');
  try {
    await su.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [tenantId, NIL],
    );
    await fn();
    await su.query('COMMIT');
  } catch (e) {
    await su.query('ROLLBACK');
    throw e;
  }
}

export async function makeRole(
  su: pg.Client,
  tenantId: string,
  name: string,
  permissions: string[],
): Promise<string> {
  const id = uuidv7();
  await asPlatform(su, tenantId, async () => {
    await su.query('INSERT INTO role (tenant_id, id, name) VALUES ($1,$2,$3)', [
      tenantId,
      id,
      name,
    ]);
    for (const p of permissions)
      await su.query(
        'INSERT INTO role_permission (tenant_id, id, role_id, permission) VALUES ($1,$2,$3,$4)',
        [tenantId, uuidv7(), id, p],
      );
  });
  return id;
}

export async function addCompany(su: pg.Client, tenantId: string, name = 'Main'): Promise<string> {
  const id = uuidv7();
  await asPlatform(su, tenantId, async () => {
    await su.query(
      'INSERT INTO company (tenant_id, id, name, base_currency) VALUES ($1,$2,$3,$4)',
      [tenantId, id, name, 'BDT'],
    );
  });
  return id;
}
