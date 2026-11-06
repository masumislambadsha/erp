import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/create-app.js';
import { ADMIN_URL, DATABASE_URL, newTenant, TOTP_KEY } from './support.js';

let tenantA = '';
let tenantB = '';
let userA = '';
let userB = '';

let app: INestApplication;
let base: string;
let su: pg.Client;

const as = (tenant: string, user: string) => ({
  'x-dev-tenant-id': tenant,
  'x-dev-user-id': user,
  'content-type': 'application/json',
});
let A: Record<string, string> = {};
let B: Record<string, string> = {};

async function api(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: text ? (JSON.parse(text) as any) : undefined };
}

beforeAll(async () => {
  su = new pg.Client({ connectionString: ADMIN_URL });
  await su.connect();
  const a = await newTenant('Isolation A');
  const b = await newTenant('Isolation B');
  [tenantA, userA, tenantB, userB] = [a.tenantId, a.adminId, b.tenantId, b.adminId];
  A = as(tenantA, userA);
  B = as(tenantB, userB);
  ({ app } = await createApp({
    DATABASE_URL,
    TOTP_ENCRYPTION_KEY: TOTP_KEY,
    JOBS_ENABLED: 'false',
    NODE_ENV: 'test',
    DEV_AUTH_STUB: 'true',
  }));
  await app.listen(0);
  base = await app.getUrl();
  base = base.replace('[::1]', 'localhost');
});

afterAll(async () => {
  await app?.close();
  await su.end();
});

describe('tenant isolation through the API', () => {
  let partyA: string;
  let partyB: string;

  it('each tenant creates and reads its own party', async () => {
    const a = await api('POST', '/parties', A, { name: 'Acme (A)' });
    const b = await api('POST', '/parties', B, { name: 'Bolt (B)' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    partyA = a.body.id;
    partyB = b.body.id;
    expect(a.body.tenantId).toBe(tenantA);
    expect(b.body.tenantId).toBe(tenantB);
    expect((await api('GET', `/parties/${partyA}`, A)).body.name).toBe('Acme (A)');
  });

  it('A lists only A’s parties', async () => {
    const list = await api('GET', '/parties', A);
    expect(list.status).toBe(200);
    expect(list.body.map((p: { id: string }) => p.id)).toEqual([partyA]);
  });

  it('A cannot read B’s party by id', async () => {
    expect((await api('GET', `/parties/${partyB}`, A)).status).toBe(404);
  });

  it('A cannot update B’s party', async () => {
    expect((await api('PATCH', `/parties/${partyB}`, A, { name: 'hijacked' })).status).toBe(404);
    expect((await su.query('SELECT name FROM party WHERE id = $1', [partyB])).rows).toEqual([
      { name: 'Bolt (B)' },
    ]);
  });

  it('A cannot delete B’s party', async () => {
    expect((await api('DELETE', `/parties/${partyB}`, A)).status).toBe(404);
    expect((await su.query('SELECT 1 FROM party WHERE id = $1', [partyB])).rowCount).toBe(1);
  });

  it('A cannot create a party in B by naming B’s tenant in the body', async () => {
    for (const key of ['tenantId', 'tenant_id']) {
      const r = await api('POST', '/parties', A, { name: 'planted', [key]: tenantB });
      expect(r.status).toBe(400);
    }
    expect(
      (
        await su.query('SELECT 1 FROM party WHERE tenant_id = $1 AND name = $2', [
          tenantB,
          'planted',
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('A cannot move its own party into B with an update', async () => {
    expect((await api('PATCH', `/parties/${partyA}`, A, { tenantId: tenantB })).status).toBe(400);
    expect((await su.query('SELECT tenant_id FROM party WHERE id = $1', [partyA])).rows).toEqual([
      { tenant_id: tenantA },
    ]);
  });

  it('B still sees exactly its own party, untouched', async () => {
    const list = await api('GET', '/parties', B);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: partyB, tenantId: tenantB, name: 'Bolt (B)' });
  });

  it('A can update and delete its own party', async () => {
    expect((await api('PATCH', `/parties/${partyA}`, A, { name: 'Acme Ltd' })).body.name).toBe(
      'Acme Ltd',
    );
    expect((await api('DELETE', `/parties/${partyA}`, A)).status).toBe(204);
    expect((await api('GET', `/parties/${partyA}`, A)).status).toBe(404);
  });
});

describe('the dev auth stub', () => {
  it('requests with no or bad context are refused (deny by default)', async () => {
    expect((await api('GET', '/parties', { 'content-type': 'application/json' })).status).toBe(401);
    expect((await api('GET', '/parties', as('nope', userA))).status).toBe(401);
    expect((await api('GET', '/parties', { 'x-dev-tenant-id': tenantA })).status).toBe(401);
  });

  it('/health is public', async () => {
    expect(await api('GET', '/health', {})).toEqual({ status: 200, body: { status: 'ok' } });
  });

  it('with the stub off, tenant headers are ignored: nothing is reachable by naming a tenant', async () => {
    const { app: locked } = await createApp({
      DATABASE_URL,
      TOTP_ENCRYPTION_KEY: TOTP_KEY,
      JOBS_ENABLED: 'false',
      NODE_ENV: 'test',
      DEV_AUTH_STUB: 'false',
    });
    await locked.listen(0);
    try {
      const url = (await locked.getUrl()).replace('[::1]', 'localhost');
      const res = await fetch(`${url}/parties`, { headers: A });
      expect(res.status).toBe(401);
      expect((await fetch(`${url}/health`)).status).toBe(200);
    } finally {
      await locked.close();
    }
  });
});
