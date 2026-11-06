import { describe, expect, it } from 'vitest';
import { PERMISSIONS, SEED_ROLES } from '../src/authz/permissions.js';
import {
  companyScope,
  fieldAccess,
  forbiddenFields,
  redact,
  type RoleRules,
} from '../src/authz/rules.js';
import { hashPassword, passwordProblem, verifyPassword } from '../src/security/password.js';
import { open, seal } from '../src/security/secret-box.js';
import {
  hashSecret,
  newSession,
  parseCookie,
  secretMatches,
} from '../src/security/session-token.js';
import {
  base32Decode,
  base32Encode,
  codeAtStep,
  otpauthUri,
  stepAt,
  verifyTotp,
} from '../src/security/totp.js';

describe('TOTP (RFC 6238)', () => {
  const secret = Buffer.from('12345678901234567890'); // the RFC's SHA-1 test secret

  it('matches the RFC test vectors (6 digits)', () => {
    // RFC 6238 appendix B, 8-digit codes truncated to their last 6 digits.
    for (const [t, code] of [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ] as const) {
      expect(codeAtStep(secret, Math.floor(t / 30))).toBe(code);
    }
  });

  it('round-trips base32', () => {
    for (const n of [1, 5, 10, 20, 33]) {
      const b = Buffer.alloc(n, 0xa7);
      expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    }
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('accepts the current step and one either side, nothing else', () => {
    const now = 1_700_000_000_000;
    const s = stepAt(now);
    for (const off of [-1, 0, 1])
      expect(verifyTotp(secret, codeAtStep(secret, s + off), now, null)).toBe(s + off);
    for (const off of [-2, 2, 10])
      expect(verifyTotp(secret, codeAtStep(secret, s + off), now, null)).toBeNull();
  });

  it('works once: a step at or below the last accepted one is refused', () => {
    const now = 1_700_000_000_000;
    const s = stepAt(now);
    expect(verifyTotp(secret, codeAtStep(secret, s), now, s)).toBeNull();
    expect(verifyTotp(secret, codeAtStep(secret, s - 1), now, s)).toBeNull();
    expect(verifyTotp(secret, codeAtStep(secret, s + 1), now, s)).toBe(s + 1);
  });

  it('refuses malformed codes', () => {
    for (const c of ['', '12345', '1234567', 'abcdef', '12 345'])
      expect(verifyTotp(secret, c, 0, null)).toBeNull();
  });

  it('builds an otpauth URI an authenticator app understands', () => {
    const uri = otpauthUri('ERP', 'a@b.test', secret);
    expect(uri).toContain(
      'otpauth://totp/ERP%3Aa%40b.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    );
    expect(uri).toContain('period=30');
  });
});

describe('secret box', () => {
  const key = Buffer.alloc(32, 9);
  it('round-trips and binds the tenant and user', () => {
    const sealed = seal(key, Buffer.from('totp secret'), 't1:u1');
    expect(open(key, sealed, 't1:u1').toString()).toBe('totp secret');
    expect(() => open(key, sealed, 't1:u2')).toThrow(); // copied to another user's row
    expect(() => open(Buffer.alloc(32, 1), sealed, 't1:u1')).toThrow();
  });
  it('detects tampering and never repeats a ciphertext', () => {
    const a = seal(key, Buffer.from('x'), 'a');
    const b = seal(key, Buffer.from('x'), 'a');
    expect(a.equals(b)).toBe(false);
    a[a.length - 1] = a[a.length - 1]! ^ 1;
    expect(() => open(key, a, 'a')).toThrow();
  });
});

describe('session token', () => {
  const tenant = '11111111-1111-4111-8111-111111111111';
  it('carries tenant, id and a secret that only its hash can confirm', () => {
    const s = newSession(tenant);
    const t = parseCookie(s.cookie)!;
    expect(t.tenantId).toBe(tenant);
    expect(t.sessionId).toBe(s.id);
    expect(secretMatches(t.secret, s.secretHash)).toBe(true);
    expect(secretMatches(t.secret + 'x', s.secretHash)).toBe(false);
    expect(secretMatches(newSession(tenant).cookie.split('.')[2]!, s.secretHash)).toBe(false);
    expect(s.cookie).not.toContain(s.secretHash.toString('base64url'));
  });
  it('rejects malformed cookies', () => {
    for (const c of [
      '',
      'a.b.c',
      `${tenant}.${tenant}`,
      `${tenant}.${tenant}.short`,
      `x.${tenant}.${'a'.repeat(43)}`,
    ]) {
      expect(parseCookie(c)).toBeNull();
    }
  });
  it('hashes with SHA-256', () => expect(hashSecret('a')).toHaveLength(32));
});

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('correct-horse-battery');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'correct-horse-battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword('not a hash', 'x')).toBe(false);
  });
  it('enforces length and rejects the email', () => {
    expect(passwordProblem('short', 'a@b.test')).toMatch(/at least/);
    expect(passwordProblem('x'.repeat(129), 'a@b.test')).toMatch(/at most/);
    expect(passwordProblem('A@B.test-and-more', 'a@b.test-and-more')).toMatch(/email/);
    expect(passwordProblem('long-enough-secret', 'a@b.test')).toBeNull();
  });
});

describe('record and field rules', () => {
  const role = (
    id: string,
    rec: Record<string, string[]> = {},
    fld: Record<string, 'hidden' | 'read_only'> = {},
  ): RoleRules => ({
    roleId: id,
    recordRules: new Map(Object.entries(rec).map(([k, v]) => [k, new Set(v)])),
    fieldRules: new Map(Object.entries(fld)),
  });

  it('a role with no rule sees every company; limited roles add up', () => {
    expect(companyScope([role('r1')], 'account')).toBeNull();
    expect(companyScope([role('r1', { account: ['c1'] })], 'account')).toEqual(['c1']);
    expect(
      companyScope(
        [role('r1', { account: ['c1'] }), role('r2', { account: ['c2'] })],
        'account',
      )?.sort(),
    ).toEqual(['c1', 'c2']);
    expect(companyScope([role('r1', { account: ['c1'] }), role('r2')], 'account')).toBeNull();
    expect(companyScope([role('r1', { item: ['c1'] })], 'account')).toBeNull(); // another entity's rule
    expect(companyScope([], 'account')).toEqual([]);
  });

  it('a field is hidden or locked only if every role hides or locks it', () => {
    const hide = role('r1', {}, { 'party.tin': 'hidden' });
    const lock = role('r2', {}, { 'party.tin': 'read_only' });
    const open_ = role('r3');
    expect(fieldAccess([hide], 'party', 'tin')).toBe('hidden');
    expect(fieldAccess([hide, lock], 'party', 'tin')).toBe('read_only');
    expect(fieldAccess([hide, open_], 'party', 'tin')).toBe('full');
    expect(fieldAccess([], 'party', 'tin')).toBe('hidden');
    expect(redact([hide], 'party', { name: 'a', tin: '123' })).toEqual({ name: 'a' });
    expect(forbiddenFields([lock], 'party', ['name', 'tin'])).toEqual(['tin']);
  });
});

describe('permission catalog', () => {
  it('seeded roles only hold catalog permissions, and admin holds all', () => {
    for (const r of SEED_ROLES) for (const p of r.permissions) expect(PERMISSIONS).toContain(p);
    expect(SEED_ROLES.find((r) => r.name === 'admin')!.permissions.sort()).toEqual(
      [...PERMISSIONS].sort(),
    );
  });
  it('requires TOTP for admins and approvers only', () => {
    expect(Object.fromEntries(SEED_ROLES.map((r) => [r.name, r.requiresTotp]))).toEqual({
      admin: true,
      approver: true,
      clerk: false,
      viewer: false,
    });
  });
});
