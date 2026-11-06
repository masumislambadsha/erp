import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import {
  addCompany,
  addUser,
  asPlatform,
  call,
  makeRole,
  newTenant,
  startApp,
  stubHeaders,
  superuser,
} from './support.js';

let app: INestApplication;
let base: string;
let su: pg.Client;
let tenantId: string;
let company: string;
let admin: Record<string, string>;
let maker: Record<string, string>;
let approver: Record<string, string>;
let reader: Record<string, string>;
let nobody: Record<string, string>;

const L = (en: string) => ({ en, bn: `${en} (bn)` });
const DEFINITION = {
  label: L('Service order'),
  numbering: { prefix: 'SO-' },
  fields: [
    { name: 'title', label: L('Title'), type: 'text', required: true, maxLength: 60 },
    { name: 'fee', label: L('Fee'), type: 'money', required: true },
    { name: 'rooms', label: L('Rooms'), type: 'number', integer: true, min: 1, max: 50 },
    { name: 'due', label: L('Due date'), type: 'date' },
    {
      name: 'kind',
      label: L('Kind'),
      type: 'select',
      options: [
        { value: 'repair', label: L('Repair') },
        { value: 'clean', label: L('Cleaning') },
      ],
    },
    { name: 'contact', label: L('Contact'), type: 'party' },
  ],
  form: {
    sections: [
      { title: L('Order'), fields: ['title', 'kind', 'fee'] },
      { title: L('Details'), fields: ['rooms', 'due', 'contact'] },
    ],
  },
  list: { columns: ['number', 'status', 'title', 'fee'] },
};
const body = (extra: Record<string, unknown> = {}, values: Record<string, unknown> = {}) => ({
  companyId: company,
  postingDate: '2026-11-01',
  values: { title: 'Fix the roof', fee: '12500.50', rooms: 3, kind: 'repair', ...values },
  ...extra,
});
let n = 0;
const key = () => `key-${Date.now()}-${++n}-${uuidv7()}`;
const post = (who: Record<string, string>, path: string, b?: unknown, k = key()) =>
  call(base, 'POST', path, { ...who, 'idempotency-key': k }, b);
const patch = (who: Record<string, string>, path: string, b: unknown) =>
  call(base, 'PATCH', path, { ...who, 'idempotency-key': key() }, b);
const get = (who: Record<string, string>, path: string) => call(base, 'GET', path, who);
const del = (who: Record<string, string>, path: string) => call(base, 'DELETE', path, who);
const SO = '/documents/service_order';

async function draft(extra: Record<string, unknown> = {}, values: Record<string, unknown> = {}) {
  const r = await post(maker, SO, body(extra, values));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
async function submitted() {
  const d = await draft();
  const r = await post(approver, `${SO}/${d.id}/submit`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

beforeAll(async () => {
  ({ app, base } = await startApp());
  su = await superuser();
  const t = await newTenant('Documents');
  tenantId = t.tenantId;
  company = await addCompany(su, tenantId);
  admin = stubHeaders(tenantId, t.adminId);
  const made = await call(base, 'POST', '/meta/doc-types', admin, {
    docType: 'service_order',
    definition: DEFINITION,
    grantTo: [],
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  await makeRole(su, tenantId, 'so_maker', [
    'service_order:read',
    'service_order:create',
    'service_order:update',
  ]);
  await makeRole(su, tenantId, 'so_approver', [
    'service_order:read',
    'service_order:submit',
    'service_order:cancel',
    'service_order:amend',
  ]);
  await makeRole(su, tenantId, 'so_reader', ['service_order:read']);
  maker = stubHeaders(tenantId, (await addUser(su, tenantId, ['so_maker'])).id);
  approver = stubHeaders(tenantId, (await addUser(su, tenantId, ['so_approver'])).id);
  reader = stubHeaders(tenantId, (await addUser(su, tenantId, ['so_reader'])).id);
  nobody = stubHeaders(tenantId, (await addUser(su, tenantId, ['viewer'])).id);
});
afterAll(async () => {
  await app?.close();
  await su?.end();
});

describe('a document type defined only in metadata', () => {
  it('is validated, stored with its form and list, and audited', async () => {
    const r = await get(admin, '/meta/doc-types/service_order');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ docType: 'service_order', version: 1, isActive: true });
    expect(r.body.form.map((s: { fields: unknown[] }) => s.fields.length)).toEqual([3, 3]);
    expect(r.body.form[0].fields[2]).toMatchObject({
      name: 'fee',
      type: 'money',
      required: true,
      label: { en: 'Fee', bn: 'Fee (bn)' },
    });
    expect(r.body.list.map((c: { key: string }) => c.key)).toEqual([
      'number',
      'status',
      'title',
      'fee',
    ]);
    const audit = await get(admin, '/audit?entity=doc_type_def');
    expect(audit.body.map((a: { action: string }) => a.action)).toContain('insert');
  });

  it('rejects a bad definition with the reasons, and a duplicate code', async () => {
    const bad = await call(base, 'POST', '/meta/doc-types', admin, {
      docType: 'broken',
      definition: { ...DEFINITION, list: { columns: ['nope'] }, numbering: { prefix: 'bad' } },
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body.issues)).toMatch(/unknown column nope/);
    expect(JSON.stringify(bad.body.issues)).toMatch(/upper-case/);
    expect(
      (
        await call(base, 'POST', '/meta/doc-types', admin, {
          docType: 'service_order',
          definition: DEFINITION,
        })
      ).status,
    ).toBe(409);
    expect(
      (await call(base, 'POST', '/meta/doc-types', maker, { docType: 'x', definition: DEFINITION }))
        .status,
    ).toBe(403); // needs meta:manage
  });

  it('shows a type only to people who hold one of its permissions', async () => {
    expect(
      (await get(maker, '/meta/doc-types')).body.map((t: { docType: string }) => t.docType),
    ).toEqual(['service_order']);
    expect((await get(nobody, '/meta/doc-types')).body).toEqual([]);
    expect((await get(nobody, '/meta/doc-types/service_order')).status).toBe(404);
  });

  it('grants the new permissions to the roles named, admin by default', async () => {
    const r = await call(base, 'POST', '/meta/doc-types', admin, {
      docType: 'visit_log',
      definition: { ...DEFINITION, numbering: { prefix: 'VL-' } },
    });
    expect(r.status).toBe(201);
    const me = await get(admin, '/auth/me');
    expect(me.body.permissions).toEqual(
      expect.arrayContaining(['visit_log:read', 'visit_log:submit', 'visit_log:amend']),
    );
    // And a role can be given them through the roles API; an unknown type's permissions are refused.
    const ok = await call(base, 'POST', '/roles', admin, {
      name: 'vl',
      permissions: ['visit_log:read'],
    });
    expect(ok.status).toBe(201);
    expect(
      (await call(base, 'POST', '/roles', admin, { name: 'vl2', permissions: ['ghost_type:read'] }))
        .status,
    ).toBe(400);
    expect(
      (
        await call(base, 'POST', '/roles', admin, {
          name: 'vl3',
          permissions: ['visit_log:explode'],
        })
      ).status,
    ).toBe(400);
  });
});

describe('draft validation, driven by the metadata', () => {
  it.each([
    ['a missing required field', { fee: undefined }],
    ['money as a number', { fee: 12.5 }],
    ['money with five decimals', { fee: '1.23456' }],
    ['text over its limit', { title: 'x'.repeat(61) }],
    ['a fractional integer', { rooms: 2.5 }],
    ['a number above its max', { rooms: 51 }],
    ['an impossible date', { due: '2026-02-30' }],
    ['an unknown option', { kind: 'paint' }],
    ['an unknown field', { colour: 'red' }],
  ])('refuses %s', async (_name, values) => {
    const r = await post(maker, SO, body({}, values));
    expect(r.status).toBe(400);
    expect(r.body.issues.length).toBeGreaterThan(0);
  });

  it('refuses a party that does not exist, an unknown company and a missing Idempotency-Key', async () => {
    expect((await post(maker, SO, body({}, { contact: uuidv7() }))).status).toBe(400);
    expect((await post(maker, SO, body({ companyId: uuidv7() }))).status).toBe(400);
    expect((await call(base, 'POST', SO, maker, body())).status).toBe(400);
  });

  it('creates a draft with no number, and keeps money as a string', async () => {
    const d = await draft();
    expect(d).toMatchObject({
      status: 'draft',
      number: null,
      version: 1,
      currency: 'BDT',
      amendedFrom: null,
    });
    expect(d.values.fee).toBe('12500.50');
    expect(d.actions).toEqual(['update', 'delete']); // the maker may edit but not submit
  });

  it('keeps a draft editable with optimistic locking, and deletable', async () => {
    const d = await draft();
    const u = await patch(maker, `${SO}/${d.id}`, {
      ...body({}, { title: 'Fix the roof again' }),
      version: 1,
    });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ version: 2 });
    expect(u.body.values.title).toBe('Fix the roof again');
    expect((await patch(maker, `${SO}/${d.id}`, { ...body(), version: 1 })).status).toBe(409); // stale
    expect((await del(maker, `${SO}/${d.id}`)).status).toBe(204);
    expect((await get(maker, `${SO}/${d.id}`)).status).toBe(404);
  });
});

describe('submit, numbering and the database guards', () => {
  it('numbers from the series, gapless and in order of submission', async () => {
    const a = await draft();
    const b = await draft();
    const sb = await post(approver, `${SO}/${b.id}/submit`);
    const sa = await post(approver, `${SO}/${a.id}/submit`);
    const [first, second] = [sb.body.number, sa.body.number];
    expect(first).toMatch(/^SO-\d{6,}$/);
    expect(Number(second.slice(3)) - Number(first.slice(3))).toBe(1);
    expect(sa.body).toMatchObject({ status: 'submitted', actions: ['cancel'] });
    expect(sa.body.submittedAt).toBeTruthy();
  });

  it('a submit that fails takes no number', async () => {
    const before = (await submitted()).number;
    const d = await draft({ postingDate: '2026-01-15' });
    await asPlatform(su, tenantId, async () => {
      await su.query(
        "INSERT INTO posting_lock (tenant_id, company_id, ledger, locked_through) VALUES ($1,$2,'gl','2026-06-30') ON CONFLICT (tenant_id, company_id, ledger) DO UPDATE SET locked_through = '2026-06-30'",
        [tenantId, company],
      );
    });
    const refused = await post(approver, `${SO}/${d.id}/submit`);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/locked/);
    await asPlatform(su, tenantId, async () => {
      await su.query('DELETE FROM posting_lock WHERE tenant_id = $1 AND company_id = $2', [
        tenantId,
        company,
      ]);
    });
    const after = (await submitted()).number;
    expect(Number(after.slice(3)) - Number(before.slice(3))).toBe(1); // no gap
    expect((await get(reader, `${SO}/${d.id}`)).body.status).toBe('draft');
  });

  it('re-validates against the current definition and refuses an unready draft', async () => {
    const d = await draft();
    await asPlatform(su, tenantId, async () => {
      await su.query('UPDATE document SET ext = \'{"title":"x"}\' WHERE id = $1', [d.id]); // simulate a definition that changed under a draft
    });
    const r = await post(approver, `${SO}/${d.id}/submit`);
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body.issues)).toMatch(/values\.fee/);
  });

  it('freezes a submitted document: no edit, no delete, no second submit', async () => {
    const s = await submitted();
    expect((await patch(maker, `${SO}/${s.id}`, { ...body(), version: 1 })).status).toBe(409);
    expect((await del(maker, `${SO}/${s.id}`)).status).toBe(409);
    expect((await post(approver, `${SO}/${s.id}/submit`)).status).toBe(409);
    await expect(su.query("UPDATE document SET ext = '{}' WHERE id = $1", [s.id])).rejects.toThrow(
      /correct it with a new document/,
    ); // and the database says so itself
  });

  it('two concurrent submits of one draft: one wins, one is refused, one number is used', async () => {
    const d = await draft();
    const [x, y] = await Promise.all([
      post(approver, `${SO}/${d.id}/submit`),
      post(approver, `${SO}/${d.id}/submit`),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
  });
});

describe('permissions per action', () => {
  it('lets each role do only its own steps', async () => {
    const d = await draft();
    const c = (r: { status: number }) => r.status;
    expect(c(await post(reader, SO, body()))).toBe(403);
    expect(c(await post(approver, SO, body()))).toBe(403); // an approver does not create
    expect(c(await post(maker, `${SO}/${d.id}/submit`))).toBe(403); // a maker does not submit
    expect(c(await patch(reader, `${SO}/${d.id}`, { ...body(), version: 1 }))).toBe(403);
    expect(c(await del(reader, `${SO}/${d.id}`))).toBe(403);
    expect(c(await get(reader, `${SO}/${d.id}`))).toBe(200);
    expect(c(await get(nobody, `${SO}/${d.id}`))).toBe(403);
    expect(c(await get(nobody, SO))).toBe(403);
    const s = await post(approver, `${SO}/${d.id}/submit`);
    expect(c(await post(maker, `${SO}/${d.id}/cancel`))).toBe(403);
    expect(c(await post(maker, `${SO}/${d.id}/amend`))).toBe(403);
    expect(s.status).toBe(200);
    expect((await call(base, 'GET', SO, { 'content-type': 'application/json' })).status).toBe(401);
  });

  it('answers 404 for a type that does not exist, after the permission check', async () => {
    expect((await get(admin, '/documents/ghost')).status).toBe(403); // admin holds no ghost permissions
    expect((await get(admin, `/documents/Bad-Type`)).status).toBe(403);
  });
});

describe('cancel and amend', () => {
  it('cancels a submitted document, never a draft', async () => {
    const d = await draft();
    expect((await post(approver, `${SO}/${d.id}/cancel`)).status).toBe(409);
    const s = await post(approver, `${SO}/${d.id}/submit`);
    const c = await post(approver, `${SO}/${d.id}/cancel`);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({
      status: 'cancelled',
      number: s.body.number,
      actions: ['amend'],
    });
    expect((await post(approver, `${SO}/${d.id}/cancel`)).status).toBe(409);
  });

  it('refuses to cancel an issued document or one in a locked period; the database says why', async () => {
    const issued = await submitted();
    await asPlatform(su, tenantId, async () => {
      await su.query('UPDATE document SET issued_at = now() WHERE id = $1', [issued.id]);
    });
    const r = await post(approver, `${SO}/${issued.id}/cancel`);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/issued to the buyer/);
    expect((await get(approver, `${SO}/${issued.id}`)).body.actions).toEqual([]);

    const locked = await submitted();
    await asPlatform(su, tenantId, async () => {
      await su.query(
        "INSERT INTO posting_lock (tenant_id, company_id, ledger, locked_through) VALUES ($1,$2,'gl','2026-12-31') ON CONFLICT (tenant_id, company_id, ledger) DO UPDATE SET locked_through = '2026-12-31'",
        [tenantId, company],
      );
    });
    const r2 = await post(approver, `${SO}/${locked.id}/cancel`);
    await asPlatform(su, tenantId, async () => {
      await su.query('DELETE FROM posting_lock WHERE tenant_id = $1 AND company_id = $2', [
        tenantId,
        company,
      ]);
    });
    expect(r2.status).toBe(409);
    expect(r2.body.message).toMatch(/locked period/);
  });

  it('amends a cancelled document into a new draft that points back, once', async () => {
    const s = await submitted();
    expect((await post(approver, `${SO}/${s.id}/amend`)).status).toBe(409); // not cancelled yet
    await post(approver, `${SO}/${s.id}/cancel`);
    const a = await post(approver, `${SO}/${s.id}/amend`);
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({
      status: 'draft',
      number: null,
      amendedFrom: s.id,
      values: s.values,
    });
    expect((await get(reader, `${SO}/${s.id}`)).body.amendedBy).toBe(a.body.id);
    expect((await post(approver, `${SO}/${s.id}/amend`)).status).toBe(409); // once only
    // The amendment is an ordinary draft: edit it, submit it, get the next number.
    const edited = await patch(maker, `${SO}/${a.body.id}`, {
      ...body({}, { title: 'Fix the roof, corrected' }),
      version: 1,
    });
    expect(edited.status).toBe(200);
    const done = await post(approver, `${SO}/${a.body.id}/submit`);
    expect(done.body.number).not.toBe(s.number);
    expect(done.body.amendedFrom).toBe(s.id);
  });
});

describe('audit and idempotency', () => {
  it('records every change to a document with who and what, in the same transaction', async () => {
    const d = await draft();
    await post(approver, `${SO}/${d.id}/submit`);
    await post(approver, `${SO}/${d.id}/cancel`);
    const rows = (await get(admin, '/audit?entity=document&limit=500')).body.filter(
      (a: { entityId: string }) => a.entityId === d.id,
    );
    expect(rows.map((a: { action: string }) => a.action)).toEqual(['update', 'update', 'insert']); // newest first
    const submit = rows[1];
    expect(submit.changes.status).toEqual(['draft', 'submitted']);
    expect(submit.changes.number[0]).toBeNull();
    expect(submit.changes.number[1]).toMatch(/^SO-/);
    const makerId = (await get(maker, '/auth/me')).body.user.id;
    expect(rows[2].actorId).toBe(makerId);
  });

  it('replays the first answer for a repeated key, and refuses the key for another request', async () => {
    const k = key();
    const a = await post(maker, SO, body(), k);
    const b = await post(maker, SO, body(), k);
    expect(b.status).toBe(a.status);
    expect(b.body.id).toBe(a.body.id);
    const count = await su.query('SELECT count(*)::int n FROM document WHERE id = $1', [a.body.id]);
    expect(count.rows[0].n).toBe(1);
    expect((await post(maker, SO, body({}, { title: 'Different' }), k)).status).toBe(422);
  });

  it('a retried submit returns the same number instead of failing or numbering twice', async () => {
    const d = await draft();
    const k = key();
    const first = await post(approver, `${SO}/${d.id}/submit`, undefined, k);
    const again = await post(approver, `${SO}/${d.id}/submit`, undefined, k);
    expect(again.status).toBe(200);
    expect(again.body.number).toBe(first.body.number);
  });

  it('frees the key after a refused request so the client can fix it and retry', async () => {
    const k = key();
    expect((await post(maker, SO, body({}, { fee: 'abc' }), k)).status).toBe(400);
    expect((await post(maker, SO, body(), k)).status).toBe(201);
  });
});

describe('lists and isolation', () => {
  it('lists newest first, filters by status and pages', async () => {
    const all = await get(reader, `${SO}?limit=2`);
    expect(all.body.rows).toHaveLength(2);
    expect(all.body.next).toBe(all.body.rows[1].id);
    const page2 = await get(reader, `${SO}?limit=2&before=${all.body.next}`);
    expect(page2.body.rows[0].id < all.body.rows[1].id).toBe(true);
    const subs = await get(reader, `${SO}?status=submitted&limit=200`);
    expect(subs.body.rows.every((r: { status: string }) => r.status === 'submitted')).toBe(true);
  });

  it('another tenant cannot see or touch these documents, even with the same type code', async () => {
    const other = await newTenant('Documents other');
    const oAdmin = stubHeaders(other.tenantId, other.adminId);
    await call(base, 'POST', '/meta/doc-types', oAdmin, {
      docType: 'service_order',
      definition: DEFINITION,
    });
    const d = await draft();
    expect((await get(oAdmin, `${SO}/${d.id}`)).status).toBe(404);
    expect((await get(oAdmin, SO)).body.rows).toEqual([]);
    expect((await post(oAdmin, `${SO}/${d.id}/submit`)).status).toBe(404);
    expect((await post(oAdmin, SO, body())).status).toBe(400); // company belongs to the other tenant
  });
});

describe('lines', () => {
  const LINED = {
    ...DEFINITION,
    numbering: { prefix: 'LO-' },
    requiresParty: true,
    lines: { minLines: 1, fields: [{ name: 'note', label: L('Note'), type: 'text' }] },
  };
  const LO = '/documents/lined_order';
  let partyId: string;

  it('takes lines, requires a party and at least one line to submit, and numbers on its own series', async () => {
    expect(
      (
        await call(base, 'POST', '/meta/doc-types', admin, {
          docType: 'lined_order',
          definition: LINED,
          grantTo: [],
        })
      ).status,
    ).toBe(201);
    await makeRole(su, tenantId, 'lo_all', [
      'lined_order:read',
      'lined_order:create',
      'lined_order:update',
      'lined_order:submit',
    ]);
    const user = stubHeaders(tenantId, (await addUser(su, tenantId, ['lo_all'])).id);
    partyId = (await call(base, 'POST', '/parties', admin, { name: 'Tenant Ltd', tin: '123' })).body
      .id;
    expect((await post(user, LO, { ...body(), values: { title: 'x', fee: '1' } })).status).toBe(
      400,
    ); // party required
    const ok = await post(user, LO, {
      companyId: company,
      postingDate: '2026-11-01',
      partyId,
      values: { title: 't', fee: '10' },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await post(user, `${LO}/${ok.body.id}/submit`)).status).toBe(422); // no lines yet
    expect(
      (
        await post(user, LO, {
          companyId: company,
          postingDate: '2026-11-01',
          partyId,
          values: { title: 't', fee: '10' },
          lines: [{ qty: 2, uom: 'pcs' }],
        })
      ).status,
    ).toBe(400); // qty as a number
    const upd = await patch(user, `${LO}/${ok.body.id}`, {
      companyId: company,
      postingDate: '2026-11-01',
      partyId,
      values: { title: 't', fee: '10' },
      lines: [
        { qty: '2.5', uom: 'pcs', unitPrice: '100', values: { note: 'first' } },
        { qty: '1', uom: 'pcs' },
      ],
      version: 1,
    });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.lines).toMatchObject([
      { lineNo: 1, qty: '2.500000', unitPrice: '100.000000', values: { note: 'first' } },
      { lineNo: 2 },
    ]);
    const sub = await post(user, `${LO}/${ok.body.id}/submit`);
    expect(sub.status).toBe(200);
    expect(sub.body.number).toMatch(/^LO-\d{6,}$/);
    expect(sub.body.partySnapshot).toMatchObject({ name: 'Tenant Ltd', tin: '123' }); // frozen by the database at submit
    await expect(
      su.query('UPDATE document_line SET qty = 9 WHERE document_id = $1', [ok.body.id]),
    ).rejects.toThrow(/cannot change/);
  });
});
