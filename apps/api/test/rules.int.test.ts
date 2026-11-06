import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { addUser, call, newTenant, NIL, startApp, stubHeaders, superuser } from './support.js';

let app: INestApplication;
let base: string;
let su: pg.Client;
let tenantId: string;
let c1: string;
let c2: string;

/** Runs SQL as the platform with the audit context the app would set. */
async function asPlatform(fn: () => Promise<void>) {
  await su.query('BEGIN');
  await su.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
    [tenantId, NIL],
  );
  await fn();
  await su.query('COMMIT');
}

async function makeRole(
  name: string,
  permissions: string[],
  record: [string, string][] = [],
  field: [string, string, string][] = [],
) {
  const id = uuidv7();
  await asPlatform(async () => {
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
    for (const [entity, company] of record)
      await su.query(
        'INSERT INTO role_record_rule (tenant_id, id, role_id, entity, company_id) VALUES ($1,$2,$3,$4,$5)',
        [tenantId, uuidv7(), id, entity, company],
      );
    for (const [entity, f, access] of field)
      await su.query(
        'INSERT INTO role_field_rule (tenant_id, id, role_id, entity, field, access) VALUES ($1,$2,$3,$4,$5,$6)',
        [tenantId, uuidv7(), id, entity, f, access],
      );
  });
}

const get = (user: string, path: string) => call(base, 'GET', path, stubHeaders(tenantId, user));

beforeAll(async () => {
  ({ app, base } = await startApp());
  su = await superuser();
  tenantId = (await newTenant('Rules')).tenantId;
  [c1, c2] = [uuidv7(), uuidv7()];
  await asPlatform(async () => {
    for (const [id, name] of [
      [c1, 'Branch 1'],
      [c2, 'Branch 2'],
    ] as [string, string][]) {
      await su.query(
        'INSERT INTO company (tenant_id, id, name, base_currency) VALUES ($1,$2,$3,$4)',
        [tenantId, id, name, 'BDT'],
      );
      await su.query(
        "INSERT INTO account (tenant_id, id, company_id, code, name, kind) VALUES ($1,$2,$3,$4,$5,'asset')",
        [tenantId, uuidv7(), id, `1000-${name.slice(-1)}`, `Cash ${name}`],
      );
    }
  });
});
afterAll(async () => {
  await app?.close();
  await su?.end();
});

describe('record rules: only my branch', () => {
  const codes = (r: { body: { code: string }[] }) => r.body.map((a) => a.code).sort();

  it('limits a role to its companies; roles add up; no rule means every company', async () => {
    await makeRole('branch1', ['account:read'], [['account', c1]]);
    await makeRole('branch2', ['account:read'], [['account', c2]]);
    await makeRole('everywhere', ['account:read']);
    await makeRole('other-entity', ['account:read'], [['item', c1]]); // a rule for another entity does not limit accounts
    const b1 = await addUser(su, tenantId, ['branch1']);
    const both = await addUser(su, tenantId, ['branch1', 'branch2']);
    const open = await addUser(su, tenantId, ['branch1', 'everywhere']);
    const all = await addUser(su, tenantId, ['everywhere']);
    const oe = await addUser(su, tenantId, ['other-entity']);
    expect(codes(await get(b1.id, '/accounts'))).toEqual(['1000-1']);
    expect(codes(await get(both.id, '/accounts'))).toEqual(['1000-1', '1000-2']);
    expect(codes(await get(open.id, '/accounts'))).toEqual(['1000-1', '1000-2']);
    expect(codes(await get(all.id, '/accounts'))).toEqual(['1000-1', '1000-2']);
    expect(codes(await get(oe.id, '/accounts'))).toEqual(['1000-1', '1000-2']);
  });
});

describe('field rules: hide the TIN', () => {
  it('hides, locks and unlocks a field for reads and writes', async () => {
    const owner = await addUser(su, tenantId, ['clerk']);
    const made = await call(base, 'POST', '/parties', stubHeaders(tenantId, owner.id), {
      name: 'Acme',
      tin: '123456789012',
    });
    expect(made.status).toBe(201);
    expect(made.body.tin).toBe('123456789012');

    await makeRole('blind', ['party:read', 'party:write'], [], [['party', 'tin', 'hidden']]);
    await makeRole('locked', ['party:read', 'party:write'], [], [['party', 'tin', 'read_only']]);
    const blind = await addUser(su, tenantId, ['blind']);
    const locked = await addUser(su, tenantId, ['locked']);
    const mixed = await addUser(su, tenantId, ['blind', 'clerk']); // the clerk role has no rule: the field is fully visible

    const asBlind = stubHeaders(tenantId, blind.id);
    const list = await call(base, 'GET', '/parties', asBlind);
    expect(list.body[0]).toMatchObject({ name: 'Acme' });
    expect(list.body[0]).not.toHaveProperty('tin');
    expect(
      await call(base, 'GET', `/parties/${made.body.id}`, asBlind).then((r) => r.body),
    ).not.toHaveProperty('tin');
    expect(
      (await call(base, 'PATCH', `/parties/${made.body.id}`, asBlind, { tin: '999' })).status,
    ).toBe(403);
    expect((await call(base, 'POST', '/parties', asBlind, { name: 'New', tin: '1' })).status).toBe(
      403,
    );
    const ok = await call(base, 'PATCH', `/parties/${made.body.id}`, asBlind, { name: 'Acme Ltd' });
    expect(ok.status).toBe(200);
    expect(ok.body).not.toHaveProperty('tin');

    const asLocked = stubHeaders(tenantId, locked.id);
    expect((await call(base, 'GET', `/parties/${made.body.id}`, asLocked)).body.tin).toBe(
      '123456789012',
    ); // visible
    expect(
      (await call(base, 'PATCH', `/parties/${made.body.id}`, asLocked, { tin: '999' })).status,
    ).toBe(403); // not editable

    expect(
      (await call(base, 'GET', `/parties/${made.body.id}`, stubHeaders(tenantId, mixed.id))).body
        .tin,
    ).toBe('123456789012');
    expect(
      (
        await call(base, 'PATCH', `/parties/${made.body.id}`, stubHeaders(tenantId, mixed.id), {
          tin: '555',
        })
      ).status,
    ).toBe(200);
    // The hidden value was never changed by the refused writes.
    const row = await su.query('SELECT tin FROM party WHERE id = $1', [made.body.id]);
    expect(row.rows[0].tin).toBe('555');
  });
});
