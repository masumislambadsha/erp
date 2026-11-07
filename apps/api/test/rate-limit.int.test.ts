import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUser,
  Browser,
  call,
  newTenant,
  PASSWORD,
  startApp,
  stubHeaders,
  superuser,
} from './support.js';

let su: pg.Client;
let T: { tenantId: string; adminId: string; adminEmail: string };

beforeAll(async () => {
  su = await superuser();
  T = await newTenant('Rate limits');
});
afterAll(async () => su?.end());

describe('sign-in is limited per client IP', () => {
  let app: INestApplication;
  let base: string;
  beforeAll(
    async () =>
      ({ app, base } = await startApp({
        RATE_LIMIT_SIGNIN_PER_MINUTE: '5',
        RATE_LIMIT_USER_PER_MINUTE: '1000',
      })),
  );
  afterAll(() => app?.close());

  it('refuses the sixth attempt in a minute, whether or not the credentials are right', async () => {
    const u = await addUser(su, T.tenantId, ['viewer']);
    const results: number[] = [];
    for (const [email, password] of [
      [u.email, 'wrong-password-1'],
      ['nobody@example.test', PASSWORD],
      [u.email, 'wrong-password-2'],
      [u.email, 'wrong-password-3'],
      [u.email, PASSWORD],
    ] as const) {
      results.push((await new Browser(base).signIn(T.tenantId, email, password)).status);
    }
    expect(results).toEqual([401, 401, 401, 401, 200]);
    const blocked = await new Browser(base).signIn(T.tenantId, u.email); // the right password, but the sixth try
    expect(blocked.status).toBe(429);
    expect(blocked.headers.getSetCookie()).toEqual([]);
  });

  it('answers a wrong realm, wrong user and wrong password with the same error before the limit', async () => {
    // (Covered at length in auth.int.test.ts; here against a fresh limit window it is the same body.)
    const r = await Promise.all([
      new Browser(base).signIn('99999999-9999-4999-8999-999999999999', 'a@example.test'),
      new Browser(base).signIn(T.tenantId, 'nobody@example.test'),
      new Browser(base).signIn(T.tenantId, T.adminEmail, 'wrong-password-1'),
    ]);
    for (const x of r) expect([x.status, x.body]).toEqual([429, r[0]!.body]); // the window above is still open: all limited alike, none says why
  });

  it('does not slow other routes or other limits', async () => {
    expect((await call(base, 'GET', '/health', {})).status).toBe(200);
  });
});

describe('the limit is per client, and proxies cannot be used to dodge it', () => {
  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    const { app, base } = await startApp({ RATE_LIMIT_SIGNIN_PER_MINUTE: '3', TRUST_PROXY: '0' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++)
        codes.push(
          (
            await call(
              base,
              'POST',
              '/auth/sign-in',
              { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i}` },
              { tenantId: T.tenantId, email: 'nobody@example.test', password: 'wrong-password-1' },
            )
          ).status,
        );
      expect(codes).toEqual([401, 401, 401, 429, 429]);
    } finally {
      await app.close();
    }
  });

  it('with one trusted proxy, separate clients get separate allowances', async () => {
    const { app, base } = await startApp({ RATE_LIMIT_SIGNIN_PER_MINUTE: '2', TRUST_PROXY: '1' });
    try {
      const attempt = (ip: string) =>
        call(
          base,
          'POST',
          '/auth/sign-in',
          { 'content-type': 'application/json', 'x-forwarded-for': ip },
          { tenantId: T.tenantId, email: 'nobody@example.test', password: 'wrong-password-1' },
        ).then((r) => r.status);
      expect([
        await attempt('1.1.1.1'),
        await attempt('1.1.1.1'),
        await attempt('1.1.1.1'),
      ]).toEqual([401, 401, 429]);
      expect(await attempt('2.2.2.2')).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('requests are limited per signed-in user', () => {
  it('stops one user at the limit and leaves another alone', async () => {
    const { app, base } = await startApp({ RATE_LIMIT_USER_PER_MINUTE: '20' });
    try {
      const a = stubHeaders(T.tenantId, (await addUser(su, T.tenantId, ['viewer'])).id);
      const b = stubHeaders(T.tenantId, (await addUser(su, T.tenantId, ['viewer'])).id);
      const codes: number[] = [];
      for (let i = 0; i < 22; i++) codes.push((await call(base, 'GET', '/parties', a)).status);
      expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
      expect(codes.slice(20)).toEqual([429, 429]);
      expect((await call(base, 'GET', '/parties', b)).status).toBe(200);
      expect((await call(base, 'GET', '/health', {})).status).toBe(200); // public and unthrottled
    } finally {
      await app.close();
    }
  });
});
