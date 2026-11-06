import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { createApp } from '../src/create-app.js';
import { resolveContext } from '../src/context/resolve-context.js';

const base = {
  DATABASE_URL: 'postgres://erp_app:pw@localhost:5432/erp',
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const T = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';

describe('config', () => {
  it('defaults to development with the stub off', () => {
    expect(loadConfig(base)).toMatchObject({
      nodeEnv: 'development',
      devAuthStub: false,
      port: 3001,
    });
  });

  it('allows the stub outside production', () => {
    expect(
      loadConfig({ ...base, NODE_ENV: 'development', DEV_AUTH_STUB: 'true' }).devAuthStub,
    ).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'test', DEV_AUTH_STUB: 'true' }).devAuthStub).toBe(true);
  });

  it('refuses production with the stub on', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', DEV_AUTH_STUB: 'true' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', DEV_AUTH_STUB: 'true' })).toThrow(
      /DEV_AUTH_STUB/,
    );
  });

  it('allows production with the stub off or unset', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).devAuthStub).toBe(false);
    expect(
      loadConfig({ ...base, NODE_ENV: 'production', DEV_AUTH_STUB: 'false' }).devAuthStub,
    ).toBe(false);
  });

  it('refuses any database role but erp_app', () => {
    for (const url of [
      'postgres://postgres:pw@localhost/erp',
      'postgres://erp_owner@localhost/erp',
    ]) {
      expect(() => loadConfig({ DATABASE_URL: url })).toThrow(/erp_app/);
    }
  });

  it('refuses a TOTP key that is not 32 bytes', () => {
    expect(() =>
      loadConfig({ ...base, TOTP_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/32 bytes/);
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(ConfigError);
  });

  it('refuses a missing database URL and a junk stub value', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, DEV_AUTH_STUB: 'yes' })).toThrow(ConfigError);
  });

  it('the API refuses to start in production with the stub on', async () => {
    await expect(
      createApp({ ...base, NODE_ENV: 'production', DEV_AUTH_STUB: 'true' }),
    ).rejects.toThrow(/DEV_AUTH_STUB=true is not allowed when NODE_ENV=production/);
  });
});

describe('resolveContext (the dev auth stub)', () => {
  const headers = { 'x-dev-tenant-id': T, 'x-dev-user-id': U };

  it('reads the headers only when the stub is on and NODE_ENV is not production', () => {
    expect(resolveContext({ devAuthStub: true, nodeEnv: 'development' }, headers)).toEqual({
      tenantId: T,
      userId: U,
    });
    expect(resolveContext({ devAuthStub: true, nodeEnv: 'test' }, headers)).toEqual({
      tenantId: T,
      userId: U,
    });
  });

  it('ignores the headers when the stub is off', () => {
    expect(resolveContext({ devAuthStub: false, nodeEnv: 'development' }, headers)).toBeNull();
  });

  it('ignores the headers in production even if the stub flag somehow got through', () => {
    expect(resolveContext({ devAuthStub: true, nodeEnv: 'production' }, headers)).toBeNull();
  });

  it('returns nothing for missing, repeated or malformed headers', () => {
    const on = { devAuthStub: true, nodeEnv: 'development' } as const;
    expect(resolveContext(on, {})).toBeNull();
    expect(resolveContext(on, { 'x-dev-tenant-id': T })).toBeNull();
    expect(resolveContext(on, { ...headers, 'x-dev-tenant-id': [T, T] })).toBeNull();
    expect(resolveContext(on, { ...headers, 'x-dev-tenant-id': "x'; --" })).toBeNull();
  });
});
