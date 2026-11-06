import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUser,
  Browser,
  call,
  codeFor,
  newTenant,
  PASSWORD,
  resetTotpReplay,
  startApp,
  stubHeaders,
  superuser,
} from './support.js';

let app: INestApplication;
let base: string;
let su: pg.Client;
let T: { tenantId: string; adminId: string; adminEmail: string };
let other: { tenantId: string; adminId: string };

beforeAll(async () => {
  ({ app, base } = await startApp());
  su = await superuser();
  T = await newTenant('Auth T');
  other = await newTenant('Auth other');
});
afterAll(async () => {
  await app?.close();
  await su?.end();
});

const events = async (tenantId: string, userId: string) =>
  (
    await su.query(
      'SELECT kind FROM auth_event WHERE tenant_id = $1 AND user_id = $2 ORDER BY id',
      [tenantId, userId],
    )
  ).rows.map((r) => r.kind as string);

describe('sign-in', () => {
  it('sets an httpOnly, SameSite cookie and opens a session', async () => {
    const u = await addUser(su, T.tenantId, ['clerk']);
    const b = new Browser(base);
    const r = await b.signIn(T.tenantId, u.email);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      user: { id: u.id, email: u.email, name: 'Test user' },
      mfa: { required: false, enrolled: false, verified: true },
    });
    const cookie = r.headers.getSetCookie()[0]!;
    expect(cookie).toMatch(
      /^erp_session=[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/,
    );
    expect(cookie).not.toContain('Secure'); // only in production
    const me = await b.send('GET', '/auth/me');
    expect(me.body).toMatchObject({
      tenantId: T.tenantId,
      roles: ['clerk'],
      mfa: { required: false, verified: true },
    });
    expect(me.body.permissions).toContain('party:write');
    expect(await events(T.tenantId, u.id)).toEqual(['sign_in']);
  });

  it('answers wrong password, unknown email and unknown tenant identically', async () => {
    const u = await addUser(su, T.tenantId, ['viewer']);
    const replies = await Promise.all([
      new Browser(base).signIn(T.tenantId, u.email, 'wrong-password-123'),
      new Browser(base).signIn(T.tenantId, 'nobody@example.test'),
      new Browser(base).signIn('99999999-9999-4999-8999-999999999999', u.email),
      new Browser(base).signIn(other.tenantId, u.email), // right email, wrong tenant
    ]);
    for (const r of replies) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual(replies[0]!.body);
      expect(r.headers.getSetCookie()).toEqual([]);
    }
  });

  it('locks the account after five wrong passwords, even for the right password', async () => {
    const u = await addUser(su, T.tenantId, ['viewer']);
    for (let i = 0; i < 5; i++)
      expect(
        (await new Browser(base).signIn(T.tenantId, u.email, 'wrong-password-123')).status,
      ).toBe(401);
    expect((await new Browser(base).signIn(T.tenantId, u.email)).status).toBe(401);
    expect((await events(T.tenantId, u.id)).filter((k) => k === 'account_locked')).toHaveLength(1);
    await su.query('UPDATE user_credential SET locked_until = NULL WHERE user_id = $1', [u.id]);
    expect((await new Browser(base).signIn(T.tenantId, u.email)).status).toBe(200);
  });

  it('stores no password or hash in the audit log or the auth events', async () => {
    const dump =
      JSON.stringify(
        (await su.query('SELECT detail FROM auth_event WHERE tenant_id = $1', [T.tenantId])).rows,
      ) +
      JSON.stringify(
        (await su.query('SELECT changes FROM audit_log WHERE tenant_id = $1', [T.tenantId])).rows,
      );
    expect(dump).not.toContain('argon2');
    expect(dump).not.toContain(PASSWORD);
  });
});

describe('sessions', () => {
  it('sign-out revokes the session, so the old cookie stops working', async () => {
    const u = await addUser(su, T.tenantId, ['clerk']);
    const b = new Browser(base);
    await b.signIn(T.tenantId, u.email);
    const old = b.cookie;
    expect((await b.send('POST', '/auth/sign-out')).status).toBe(204);
    const replay = new Browser(base);
    replay.cookie = old;
    expect((await replay.send('GET', '/auth/me')).status).toBe(401);
    expect(
      (
        await su.query(
          'SELECT count(*)::int n FROM session WHERE user_id = $1 AND revoked_at IS NOT NULL',
          [u.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('refuses a state change without the CSRF header, but allows reads', async () => {
    const u = await addUser(su, T.tenantId, ['clerk']);
    const b = new Browser(base);
    await b.signIn(T.tenantId, u.email);
    const headers = { cookie: b.cookie, 'content-type': 'application/json' };
    expect((await call(base, 'POST', '/parties', headers, { name: 'x' })).status).toBe(403);
    expect((await call(base, 'GET', '/parties', headers)).status).toBe(200);
    expect(
      (await call(base, 'POST', '/parties', { ...headers, 'x-erp-csrf': '1' }, { name: 'x' }))
        .status,
    ).toBe(201);
  });

  it('does not let a client choose the tenant: a forged tenant part finds nothing', async () => {
    const u = await addUser(su, T.tenantId, ['clerk']);
    const b = new Browser(base);
    await b.signIn(T.tenantId, u.email);
    const [, sessionId, secret] = b.cookie.replace('erp_session=', '').split('.');
    for (const forged of [
      `${other.tenantId}.${sessionId}.${secret}`,
      `${T.tenantId}.${sessionId}.${'A'.repeat(43)}`,
      `${T.tenantId}.${other.adminId}.${secret}`,
    ]) {
      const x = new Browser(base);
      x.cookie = `erp_session=${forged}`;
      expect((await x.send('GET', '/auth/me')).status).toBe(401);
    }
  });

  it('ends at the absolute limit and after idling too long', async () => {
    const u = await addUser(su, T.tenantId, ['clerk']);
    const b = new Browser(base);
    await b.signIn(T.tenantId, u.email);
    expect((await b.send('GET', '/auth/me')).status).toBe(200);
    await su.query(
      "UPDATE session SET last_seen_at = now() - interval '31 minutes' WHERE user_id = $1",
      [u.id],
    );
    expect((await b.send('GET', '/auth/me')).status).toBe(401);
    const c = new Browser(base);
    await c.signIn(T.tenantId, u.email);
    await su.query(
      "UPDATE session SET expires_at = now() - interval '1 second' WHERE user_id = $1 AND revoked_at IS NULL",
      [u.id],
    );
    expect((await c.send('GET', '/auth/me')).status).toBe(401);
  });

  it('lists your sessions, revokes the others, and cannot touch a stranger’s', async () => {
    const u = await addUser(su, T.tenantId, ['clerk']);
    const v = await addUser(su, T.tenantId, ['clerk']);
    const a1 = new Browser(base);
    const a2 = new Browser(base);
    const vb = new Browser(base);
    await a1.signIn(T.tenantId, u.email);
    await a2.signIn(T.tenantId, u.email);
    await vb.signIn(T.tenantId, v.email);
    const list = (await a1.send('GET', '/auth/sessions')).body;
    expect(list).toHaveLength(2);
    expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const theirs = (await vb.send('GET', '/auth/sessions')).body[0].id;
    expect((await a1.send('DELETE', `/auth/sessions/${theirs}`)).status).toBe(403); // no session:revoke
    expect((await a1.send('POST', '/auth/sessions/revoke-others')).body).toEqual({ revoked: 1 });
    expect((await a2.send('GET', '/auth/me')).status).toBe(401); // revoked at once, not at some expiry
    expect((await a1.send('GET', '/auth/me')).status).toBe(200);
    expect((await vb.send('GET', '/auth/me')).status).toBe(200);
  });

  it('changing the password revokes other sessions and the old password', async () => {
    const u = await addUser(su, T.tenantId, ['clerk']);
    const a = new Browser(base);
    const b = new Browser(base);
    await a.signIn(T.tenantId, u.email);
    await b.signIn(T.tenantId, u.email);
    expect(
      (
        await a.send('POST', '/auth/password', {
          current: 'nope-nope-nope-1',
          next: 'brand-new-password-1',
        })
      ).status,
    ).toBe(401);
    expect(
      (await a.send('POST', '/auth/password', { current: PASSWORD, next: 'short' })).status,
    ).toBe(400);
    expect(
      (await a.send('POST', '/auth/password', { current: PASSWORD, next: 'brand-new-password-1' }))
        .status,
    ).toBe(204);
    expect((await b.send('GET', '/auth/me')).status).toBe(401);
    expect((await a.send('GET', '/auth/me')).status).toBe(200);
    expect((await new Browser(base).signIn(T.tenantId, u.email, PASSWORD)).status).toBe(401);
    expect(
      (await new Browser(base).signIn(T.tenantId, u.email, 'brand-new-password-1')).status,
    ).toBe(200);
  });
});

describe('two-factor sign-in', () => {
  it('holds an admin to TOTP: enrol, then verify, before anything else works', async () => {
    const b = new Browser(base);
    const r = await b.signIn(T.tenantId, T.adminEmail);
    expect(r.body.mfa).toEqual({ required: true, enrolled: false, verified: false });
    const blocked = await b.send('GET', '/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('mfa_required');
    expect((await b.send('GET', '/auth/me')).status).toBe(200);
    expect((await b.send('POST', '/auth/totp/verify', { code: '000000' })).status).toBe(409); // not enrolled yet

    const enrol = (await b.send('POST', '/auth/totp/enroll')).body;
    expect(enrol.otpauthUri).toContain('otpauth://totp/');
    expect(enrol.secret).toMatch(/^[A-Z2-7]{32}$/);
    // Encrypted at rest: the base32 secret and its raw bytes are nowhere in the row.
    const stored = (
      await su.query('SELECT totp_secret FROM user_credential WHERE user_id = $1', [T.adminId])
    ).rows[0].totp_secret as Buffer;
    expect(stored.length).toBeGreaterThan(28);
    expect(stored.toString('latin1')).not.toContain(enrol.secret);

    expect((await b.send('POST', '/auth/totp/verify', { code: '12345' })).status).toBe(400);
    const wrong = codeFor(enrol.secret, 0) === '000000' ? '000001' : '000000';
    expect((await b.send('POST', '/auth/totp/verify', { code: wrong })).status).toBe(401);
    expect((await b.send('GET', '/users')).status).toBe(403);
    expect(
      (await b.send('POST', '/auth/totp/verify', { code: codeFor(enrol.secret) })).status,
    ).toBe(204);
    expect((await b.send('GET', '/users')).status).toBe(200);
    expect((await b.send('GET', '/auth/me')).body.mfa).toEqual({
      required: true,
      enrolled: true,
      verified: true,
    });
    expect((await b.send('POST', '/auth/totp/enroll')).status).toBe(409); // already set up

    // A second session starts unverified, and the code just used cannot be replayed.
    const b2 = new Browser(base);
    expect((await b2.signIn(T.tenantId, T.adminEmail)).body.mfa).toEqual({
      required: true,
      enrolled: true,
      verified: false,
    });
    expect(
      (await b2.send('POST', '/auth/totp/verify', { code: codeFor(enrol.secret) })).status,
    ).toBe(401);
    expect(
      (await b2.send('POST', '/auth/totp/verify', { code: codeFor(enrol.secret, 1) })).status,
    ).toBe(204);
    expect((await b2.send('GET', '/users')).status).toBe(200);
    expect(await events(T.tenantId, T.adminId)).toEqual(
      expect.arrayContaining([
        'totp_enrol_started',
        'totp_failed',
        'totp_enrolled',
        'totp_verified',
      ]),
    );
    await resetTotpReplay(su, T.adminId);
  });

  it('revokes the session and locks the account after five wrong codes', async () => {
    const t = await newTenant('Auth totp lock');
    const b = new Browser(base);
    await b.signIn(t.tenantId, t.adminEmail);
    const { secret } = (await b.send('POST', '/auth/totp/enroll')).body;
    const wrong = codeFor(secret, 0) === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++)
      expect((await b.send('POST', '/auth/totp/verify', { code: wrong })).status).toBe(401);
    expect((await b.send('GET', '/auth/me')).status).toBe(401); // the session is gone
    expect((await new Browser(base).signIn(t.tenantId, t.adminEmail)).status).toBe(401); // and the account is locked
  });

  it('does not ask a clerk for a code', async () => {
    const u = await addUser(su, T.tenantId, ['clerk']);
    const b = new Browser(base);
    expect((await b.signIn(T.tenantId, u.email)).body.mfa.required).toBe(false);
    expect((await b.send('GET', '/parties')).status).toBe(200);
  });

  it('is refused to the development stub, which has no session to verify', async () => {
    const r = await call(base, 'POST', '/auth/totp/enroll', stubHeaders(T.tenantId, T.adminId));
    expect(r.status).toBe(403);
  });
});

describe('administration', () => {
  async function admin(): Promise<{
    b: Browser;
    t: { tenantId: string; adminId: string; adminEmail: string };
  }> {
    const t = await newTenant('Auth admin');
    const b = new Browser(base);
    await b.signIn(t.tenantId, t.adminEmail);
    const { secret } = (await b.send('POST', '/auth/totp/enroll')).body;
    await b.send('POST', '/auth/totp/verify', { code: codeFor(secret) });
    return { b, t };
  }

  it('creates users, rejects weak passwords and duplicate emails, assigns roles, audits it', async () => {
    const { b, t } = await admin();
    expect(
      (
        await b.send('POST', '/users', {
          email: 'new@example.test',
          name: 'New',
          password: 'short',
        })
      ).status,
    ).toBe(400);
    const made = await b.send('POST', '/users', {
      email: ' New@Example.test ',
      name: 'New',
      password: PASSWORD,
    });
    expect(made.status).toBe(201);
    expect(made.body.email).toBe('new@example.test');
    expect(
      (
        await b.send('POST', '/users', {
          email: 'new@example.test',
          name: 'Dup',
          password: PASSWORD,
        })
      ).status,
    ).toBe(409);
    const roles = (await b.send('GET', '/roles')).body as { id: string; name: string }[];
    const clerk = roles.find((r) => r.name === 'clerk')!;
    expect(
      (await b.send('PUT', `/users/${made.body.id}/roles`, { roleIds: [clerk.id] })).status,
    ).toBe(204);
    expect(
      (await b.send('PUT', `/users/${made.body.id}/roles`, { roleIds: [made.body.id] })).status,
    ).toBe(400); // unknown role
    expect((await b.send('PUT', `/users/${t.adminId}/roles`, { roleIds: [] })).status).toBe(400); // not your own
    const list = (await b.send('GET', '/users')).body as { email: string; roles: string[] }[];
    expect(list.find((u) => u.email === 'new@example.test')!.roles).toEqual(['clerk']);
    const audit = (await b.send('GET', '/audit?entity=user_role')).body;
    expect(audit.length).toBeGreaterThan(0);
    expect(
      (await b.send('GET', '/audit?entity=app_user')).body.some(
        (a: { action: string }) => a.action === 'insert',
      ),
    ).toBe(true);
    // The new user can sign in and holds only the clerk's permissions.
    const nb = new Browser(base);
    expect((await nb.signIn(t.tenantId, 'new@example.test')).status).toBe(200);
    expect((await nb.send('GET', '/users')).status).toBe(403);
  });

  it('disabling a user ends their sessions and blocks sign-in; you cannot disable yourself', async () => {
    const { b, t } = await admin();
    const u = await addUser(su, t.tenantId, ['clerk']);
    const ub = new Browser(base);
    await ub.signIn(t.tenantId, u.email);
    expect((await b.send('PATCH', `/users/${t.adminId}`, { status: 'disabled' })).status).toBe(400);
    expect((await b.send('PATCH', `/users/${u.id}`, { status: 'disabled' })).status).toBe(200);
    expect((await ub.send('GET', '/auth/me')).status).toBe(401);
    expect((await new Browser(base).signIn(t.tenantId, u.email)).status).toBe(401);
    expect((await b.send('PATCH', `/users/${u.id}`, { status: 'active' })).status).toBe(200);
    expect((await new Browser(base).signIn(t.tenantId, u.email)).status).toBe(200);
  });

  it('an admin revokes another user’s sessions', async () => {
    const { b, t } = await admin();
    const u = await addUser(su, t.tenantId, ['clerk']);
    const ub = new Browser(base);
    await ub.signIn(t.tenantId, u.email);
    expect((await b.send('DELETE', `/users/${u.id}/sessions`)).body).toEqual({ revoked: 1 });
    expect((await ub.send('GET', '/auth/me')).status).toBe(401);
  });

  it('manages roles: validates permissions, replaces them, protects seeded roles', async () => {
    const { b } = await admin();
    expect(
      (await b.send('POST', '/roles', { name: 'x', permissions: ['party:destroy'] })).status,
    ).toBe(400);
    const made = await b.send('POST', '/roles', {
      name: 'auditor',
      permissions: ['audit:read', 'party:read'],
      requiresTotp: true,
      fieldRules: [{ entity: 'party', field: 'tin', access: 'hidden' }],
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      name: 'auditor',
      requiresTotp: true,
      permissions: ['audit:read', 'party:read'],
      fieldRules: [{ entity: 'party', field: 'tin', access: 'hidden' }],
    });
    expect((await b.send('POST', '/roles', { name: 'auditor', permissions: [] })).status).toBe(409);
    const replaced = await b.send('PUT', `/roles/${made.body.id}`, {
      name: 'auditor',
      permissions: ['audit:read'],
    });
    expect(replaced.body.permissions).toEqual(['audit:read']);
    expect(replaced.body.fieldRules).toEqual([]);
    expect((await b.send('DELETE', `/roles/${made.body.id}`)).status).toBe(204);
    const seeded = (await b.send('GET', '/roles')).body.find(
      (r: { name: string }) => r.name === 'admin',
    );
    expect((await b.send('DELETE', `/roles/${seeded.id}`)).status).toBe(409);
  });
});

describe('the development stub', () => {
  it('names a user who must exist; unknown users get 401, and permissions still come from roles', async () => {
    expect(
      (
        await call(
          base,
          'GET',
          '/parties',
          stubHeaders(T.tenantId, '99999999-9999-4999-8999-999999999999'),
        )
      ).status,
    ).toBe(401);
    const u = await addUser(su, T.tenantId, []);
    expect((await call(base, 'GET', '/parties', stubHeaders(T.tenantId, u.id))).status).toBe(403); // no roles, no permissions
    // A user of another tenant cannot be borrowed.
    expect(
      (await call(base, 'GET', '/parties', stubHeaders(T.tenantId, other.adminId))).status,
    ).toBe(401);
  });
});
