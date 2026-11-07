import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Type } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createApp } from '../src/create-app.js';
import { buildOpenApi } from '../src/openapi.js';

const env = {
  DATABASE_URL: 'postgres://erp_app@localhost/none',
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  JOBS_ENABLED: 'false',
  NODE_ENV: 'test',
};

async function spec() {
  const { app, config } = await createApp(env);
  try {
    return buildOpenApi(app, (AppModule.forRoot(config).controllers ?? []) as Type[]);
  } finally {
    await app.close();
  }
}

describe('the OpenAPI spec', () => {
  it('has every route, with bodies from the Zod schemas, permissions and the headers writes need', async () => {
    const s = await spec();
    const op = (path: string, method: string) => (s.paths[path] as Record<string, any>)[method]; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(Object.keys(s.paths).length).toBeGreaterThanOrEqual(29);
    const signIn = op('/auth/sign-in', 'post');
    expect(
      Object.keys(signIn.requestBody.content['application/json'].schema.properties).sort(),
    ).toEqual(['email', 'password', 'tenantId']);
    expect(signIn['x-access']).toBe('public');
    expect(signIn.security).toBeUndefined();
    const submit = op('/documents/{docType}/{id}/submit', 'post');
    expect(submit['x-access']).toBe('permission <docType>:submit');
    expect(submit.parameters.map((p: { name: string }) => p.name)).toEqual(
      expect.arrayContaining(['Idempotency-Key', 'x-erp-csrf']),
    );
    expect(op('/reports/trial-balance', 'get')['x-access']).toBe('permission report:read');
    expect(
      op('/reports/trial-balance', 'get').parameters.map((p: { name: string }) => p.name),
    ).toEqual(expect.arrayContaining(['companyId', 'asOf']));
    expect(
      op('/users', 'post').requestBody.content['application/json'].schema.properties.password,
    ).toBeDefined();
    expect(op('/health', 'get')['x-access']).toBe('public');
    expect(s.components?.securitySchemes).toHaveProperty('session');
  });

  it('matches the committed docs/openapi.json (regenerate with: pnpm --filter @erp/api openapi)', async () => {
    const committed = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../docs/openapi.json'), 'utf8'),
    );
    expect(JSON.parse(JSON.stringify(await spec()))).toEqual(committed);
  });
});
