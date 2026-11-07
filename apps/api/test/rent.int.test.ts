import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { provisionTenantZero, type TenantZero } from '../src/cli/tenant-zero.js';
import { NIL_USER } from '../src/context/request-context.js';
import { DatabaseService } from '../src/database/database.service.js';
import { checkTenant } from '../src/jobs/integrity.js';
import {
  addCompany,
  addUser,
  ADMIN_URL,
  asPlatform,
  call,
  newTenant,
  PASSWORD,
  startApp,
  stubHeaders,
  superuser,
} from './support.js';

let app: INestApplication;
let base: string;
let su: pg.Client;
let tz: TenantZero;
let admin: Record<string, string>;
let clerk: Record<string, string>;
let approver: Record<string, string>;
let renter: string;

const key = () => `k-${uuidv7()}`;
const send = (who: Record<string, string>, method: string, path: string, body?: unknown) =>
  call(base, method, path, { ...who, 'idempotency-key': key() }, body);
const INV = '/documents/rent_invoice';
const RCT = '/documents/rent_receipt';

const invoiceBody = (over: Record<string, unknown> = {}, values: Record<string, unknown> = {}) => ({
  companyId: tz.companyId,
  postingDate: '2026-11-01',
  partyId: renter,
  values: {
    room: '3A',
    period_start: '2026-11-01',
    period_end: '2026-11-30',
    amount: '15000.00',
    due_date: '2026-11-10',
    ...values,
  },
  ...over,
});
const receiptBody = (invoiceId: string, amount: string, over: Record<string, unknown> = {}) => ({
  companyId: tz.companyId,
  postingDate: '2026-11-05',
  partyId: renter,
  values: { invoice: invoiceId, amount },
  ...over,
});

async function invoice(over = {}, values = {}) {
  const d = await send(clerk, 'POST', INV, invoiceBody(over, values));
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  const s = await send(admin, 'POST', `${INV}/${d.body.id}/submit`);
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  return s.body;
}
async function receipt(invoiceId: string, amount: string, over = {}) {
  const d = await send(clerk, 'POST', RCT, receiptBody(invoiceId, amount, over));
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  return send(admin, 'POST', `${RCT}/${d.body.id}/submit`);
}
const trialBalance = async (asOf = '2026-12-31', who = admin, company = tz.companyId) =>
  call(base, 'GET', `/reports/trial-balance?companyId=${company}&asOf=${asOf}`, who);
const rowsOf = (tb: { body: { rows: { code: string; debit: string; credit: string }[] } }) =>
  Object.fromEntries(tb.body.rows.map((r) => [r.code, [r.debit, r.credit]]));
const ledger = async (documentId: string) =>
  (
    await su.query(
      'SELECT j.kind, a.code, g.amount::text, g.party_id FROM journal j JOIN gl_line g ON g.journal_id = j.id JOIN account a ON a.id = g.account_id WHERE j.document_id = $1 ORDER BY j.kind, g.amount DESC',
      [documentId],
    )
  ).rows;
const remaining = async (documentId: string) =>
  (
    await su.query(
      "SELECT oi.remaining::text r FROM open_item oi JOIN journal j ON j.id = oi.journal_id WHERE j.document_id = $1 AND j.kind = 'post'",
      [documentId],
    )
  ).rows[0]?.r as string;

beforeAll(async () => {
  ({ app, base } = await startApp());
  su = await superuser();
  tz = await provisionTenantZero(ADMIN_URL, {
    tenantName: 'Rental building',
    adminEmail: `landlord-${uuidv7()}@example.test`,
    adminName: 'Landlord',
    adminPassword: PASSWORD,
  });
  admin = stubHeaders(tz.tenantId, tz.adminUserId);
  clerk = stubHeaders(tz.tenantId, (await addUser(su, tz.tenantId, ['rent_clerk'])).id);
  approver = stubHeaders(tz.tenantId, (await addUser(su, tz.tenantId, ['approver'])).id);
  renter = (await send(admin, 'POST', '/parties', { name: 'Room 3A renter', tin: '123456789012' }))
    .body.id;
});
afterAll(async () => {
  await app?.close();
  await su?.end();
});

describe('tenant zero is set up as data', () => {
  it('has a company, three accounts, posting setup by event, and both document types with their roles', async () => {
    const accounts = (
      await su.query(
        'SELECT code, name, control_for FROM account WHERE tenant_id = $1 ORDER BY code',
        [tz.tenantId],
      )
    ).rows;
    expect(accounts).toEqual([
      { code: '1010', name: 'Cash and bank', control_for: null },
      { code: '1200', name: 'Rent receivable', control_for: 'receivable' },
      { code: '4000', name: 'Rent income', control_for: null },
    ]);
    expect(
      (
        await su.query('SELECT event FROM posting_setup WHERE tenant_id = $1 ORDER BY event', [
          tz.tenantId,
        ])
      ).rows.map((r) => r.event),
    ).toEqual(['cash', 'receivable', 'revenue']);
    const types = await call(base, 'GET', '/meta/doc-types', admin);
    expect(types.body.map((t: { docType: string }) => t.docType)).toEqual([
      'rent_invoice',
      'rent_receipt',
    ]);
    expect(types.body[0].definition.label).toEqual({ en: 'Rent invoice', bn: 'ভাড়ার চালান' });
    // The clerk drafts, the admin submits: maker and checker are different roles.
    expect((await send(clerk, 'POST', INV, invoiceBody())).status).toBe(201);
    const d = await send(clerk, 'POST', INV, invoiceBody());
    expect((await send(clerk, 'POST', `${INV}/${d.body.id}/submit`)).status).toBe(403);
  });
});

describe('a rent invoice goes through a receipt to the trial balance', () => {
  let inv: { id: string; number: string };
  let rct: { id: string; number: string };

  it('the invoice posts an open item and revenue', async () => {
    inv = await invoice();
    expect(inv.number).toMatch(/^RI-\d{6,}$/);
    expect(await ledger(inv.id)).toEqual([
      { kind: 'post', code: '1200', amount: '15000.0000', party_id: renter },
      { kind: 'post', code: '4000', amount: '-15000.0000', party_id: null },
    ]);
    expect(await remaining(inv.id)).toBe('15000.0000');
    const tb = await trialBalance();
    expect(rowsOf(tb)).toMatchObject({
      '1200': ['15000.0000', '0.0000'],
      '4000': ['0.0000', '15000.0000'],
    });
    expect(tb.body.totals).toEqual({ debit: '15000.0000', credit: '15000.0000', balanced: true });
  });

  it('the receipt posts cash and settles the invoice', async () => {
    const s = await receipt(inv.id, '15000.00');
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    rct = s.body;
    expect(rct.number).toMatch(/^RR-\d{6,}$/);
    expect(await ledger(rct.id)).toEqual([
      { kind: 'post', code: '1010', amount: '15000.0000', party_id: null },
      { kind: 'post', code: '1200', amount: '-15000.0000', party_id: renter },
    ]);
    expect(await remaining(inv.id)).toBe('0.0000'); // the invoice is paid
    expect(await remaining(rct.id)).toBe('0.0000'); // and the receipt is fully applied
    const settled = await su.query(
      'SELECT s.kind, s.amount::text a FROM settlement s JOIN journal j ON j.id = s.journal_id WHERE j.document_id = $1',
      [rct.id],
    );
    expect(settled.rows).toEqual([{ kind: 'apply', a: '15000.0000' }]);
  });

  it('the trial balance shows both: cash and income, and nothing left on the receivable', async () => {
    const tb = await trialBalance();
    expect(tb.status).toBe(200);
    expect(rowsOf(tb)).toEqual({
      '1010': ['15000.0000', '0.0000'],
      '4000': ['0.0000', '15000.0000'],
    });
    expect(tb.body.totals).toEqual({ debit: '15000.0000', credit: '15000.0000', balanced: true });
    // As of the invoice date the receipt had not happened yet.
    expect(rowsOf(await trialBalance('2026-11-04'))).toEqual({
      '1200': ['15000.0000', '0.0000'],
      '4000': ['0.0000', '15000.0000'],
    });
    expect((await trialBalance('2026-10-31')).body.rows).toEqual([]);
  });

  it('the books pass the nightly integrity check', async () => {
    const r = await checkTenant(app.get(DatabaseService), tz.tenantId);
    expect(r.differences, JSON.stringify(r.detail)).toBe(0);
  });
});

describe('payments', () => {
  it('applies part payments and refuses more than is owed', async () => {
    const inv = await invoice({}, { amount: '8000.00', room: '2B' });
    expect((await receipt(inv.id, '3000.00')).status).toBe(200);
    expect(await remaining(inv.id)).toBe('5000.0000');
    const over = await receipt(inv.id, '6000.00');
    expect(over.status).toBe(422);
    expect(over.body.message).toMatch(/more than the 5000/);
    expect(await remaining(inv.id)).toBe('5000.0000');
    expect((await receipt(inv.id, '5000.00')).status).toBe(200);
    expect(await remaining(inv.id)).toBe('0.0000');
    expect((await receipt(inv.id, '1.00')).status).toBe(422); // nothing is owed any more
  });

  it('refuses a receipt for something that is not a submitted invoice of the same renter', async () => {
    const draft = await send(clerk, 'POST', INV, invoiceBody());
    expect((await send(clerk, 'POST', RCT, receiptBody(draft.body.id, '100'))).status).toBe(400); // a draft
    expect((await send(clerk, 'POST', RCT, receiptBody(uuidv7(), '100'))).status).toBe(400); // nothing
    const other = (await send(admin, 'POST', '/parties', { name: 'Someone else' })).body.id;
    const inv = await invoice();
    const wrong = await send(clerk, 'POST', RCT, receiptBody(inv.id, '100', { partyId: other }));
    expect(wrong.status).toBe(201); // a draft may be wrong…
    expect((await send(admin, 'POST', `${RCT}/${wrong.body.id}/submit`)).status).toBe(422); // …but it cannot post
    expect((await send(admin, 'GET', `${RCT}/${wrong.body.id}`)).body.status).toBe('draft');
  });
});

describe('cancelling reverses the books', () => {
  it('cancels a receipt (the invoice is owed again), then the invoice (the books are empty), then amends', async () => {
    const before = rowsOf(await trialBalance());
    const inv = await invoice({}, { amount: '12000.00', room: '4C' });
    const rct = (await receipt(inv.id, '12000.00')).body;
    expect(await remaining(inv.id)).toBe('0.0000');

    const stuck = await send(admin, 'POST', `${INV}/${inv.id}/cancel`);
    expect(stuck.status).toBe(422); // the invoice was settled by the receipt
    expect(stuck.body.message).toMatch(/cancel that first/);

    const c1 = await send(admin, 'POST', `${RCT}/${rct.id}/cancel`);
    expect(c1.status, JSON.stringify(c1.body)).toBe(200);
    expect(c1.body.status).toBe('cancelled');
    expect(await remaining(inv.id)).toBe('12000.0000'); // unapplied: owed again
    expect((await ledger(rct.id)).map((l) => l.kind)).toEqual([
      'post',
      'post',
      'reverse',
      'reverse',
    ]);

    const c2 = await send(admin, 'POST', `${INV}/${inv.id}/cancel`);
    expect(c2.status, JSON.stringify(c2.body)).toBe(200);
    expect(rowsOf(await trialBalance())).toEqual(before); // as if neither had happened
    expect((await checkTenant(app.get(DatabaseService), tz.tenantId)).differences).toBe(0);

    const am = await send(admin, 'POST', `${INV}/${inv.id}/amend`);
    expect(am.status).toBe(201);
    const again = await send(admin, 'POST', `${INV}/${am.body.id}/submit`);
    expect(again.status).toBe(200);
    expect(again.body.number).not.toBe(inv.number);
    expect(await remaining(am.body.id)).toBe('12000.0000');
    expect((await checkTenant(app.get(DatabaseService), tz.tenantId)).differences).toBe(0);
  });
});

describe('the kernel still guards the posting', () => {
  it('nothing posts into a closed month: the document stays a draft and takes no number', async () => {
    await asPlatform(su, tz.tenantId, async () => {
      await su.query(
        "INSERT INTO posting_lock (tenant_id, company_id, ledger, locked_through) VALUES ($1,$2,'gl','2026-09-30') ON CONFLICT (tenant_id, company_id, ledger) DO UPDATE SET locked_through = '2026-09-30'",
        [tz.tenantId, tz.companyId],
      );
    });
    try {
      const d = await send(
        clerk,
        'POST',
        INV,
        invoiceBody(
          { postingDate: '2026-09-15' },
          { due_date: '2026-09-25', period_start: '2026-09-01', period_end: '2026-09-30' },
        ),
      );
      const refused = await send(admin, 'POST', `${INV}/${d.body.id}/submit`);
      expect(refused.status).toBe(409);
      expect(refused.body.message).toMatch(/locked/);
      const after = (await send(admin, 'GET', `${INV}/${d.body.id}`)).body;
      expect(after).toMatchObject({ status: 'draft', number: null });
      expect(await ledger(d.body.id)).toEqual([]);
    } finally {
      await asPlatform(su, tz.tenantId, async () => {
        await su.query('DELETE FROM posting_lock WHERE tenant_id = $1', [tz.tenantId]);
      });
    }
  });

  it('a company with no posting setup cannot post, and the submit rolls back whole', async () => {
    const bare = await addCompany(su, tz.tenantId, 'No setup');
    const d = await send(clerk, 'POST', INV, invoiceBody({ companyId: bare }));
    const r = await send(admin, 'POST', `${INV}/${d.body.id}/submit`);
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/no posting setup for "receivable"/);
    expect((await send(admin, 'GET', `${INV}/${d.body.id}`)).body).toMatchObject({
      status: 'draft',
      number: null,
    });
  });

  it('a foreign-currency invoice is refused until foreign currency arrives', async () => {
    const d = await send(clerk, 'POST', INV, invoiceBody({ currency: 'USD' }));
    const r = await send(admin, 'POST', `${INV}/${d.body.id}/submit`);
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/company currency/);
  });
});

describe('rounding is a currency setting (D17)', () => {
  const setMode = (mode: string) =>
    asPlatform(su, tz.tenantId, async () => {
      await su.query(
        "UPDATE currency_setting SET rounding_mode = $2 WHERE tenant_id = $1 AND code = 'BDT'",
        [tz.tenantId, mode],
      );
    });
  const posted = async (id: string) => (await ledger(id)).find((l) => l.code === '4000')!.amount;

  it('rounds each posted line half up to two places by default, and the setting changes it', async () => {
    try {
      expect(await posted((await invoice({}, { amount: '1000.005' })).id)).toBe('-1000.0100'); // half up: the tie goes away from zero
      await setMode('half_even');
      expect(await posted((await invoice({}, { amount: '2000.005' })).id)).toBe('-2000.0000'); // half even: the tie goes to the even digit
      await setMode('down');
      expect(await posted((await invoice({}, { amount: '3000.009' })).id)).toBe('-3000.0000');
      await setMode('up');
      expect(await posted((await invoice({}, { amount: '4000.001' })).id)).toBe('-4000.0100');
    } finally {
      await setMode('half_up');
    }
    expect((await checkTenant(app.get(DatabaseService), tz.tenantId)).differences).toBe(0);
  });

  it('a receipt rounds the same way, and a sum that rounds to nothing is refused', async () => {
    const inv = await invoice({}, { amount: '500.00', room: '9Z' });
    expect((await receipt(inv.id, '100.004')).status).toBe(200);
    expect(await remaining(inv.id)).toBe('400.0000'); // 100.004 posts as 100.00
    const r = await receipt(inv.id, '0.004');
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/above zero/);
  });

  it('the setting is audited, and tenant zero starts with BDT at two places', async () => {
    const { rows } = await su.query(
      "SELECT minor_unit, rounding_mode FROM currency_setting WHERE tenant_id = $1 AND code = 'BDT'",
      [tz.tenantId],
    );
    expect(rows).toEqual([{ minor_unit: 2, rounding_mode: 'half_up' }]);
    const audit = await call(base, 'GET', '/audit?entity=currency_setting', admin);
    expect(audit.body.length).toBeGreaterThanOrEqual(1);
  });
});

describe('who sees the books', () => {
  it('the trial balance needs report:read; the clerk has none, the approver has', async () => {
    expect((await trialBalance('2026-12-31', clerk)).status).toBe(403);
    expect((await trialBalance('2026-12-31', approver)).status).toBe(200);
    expect((await trialBalance('2026-13-40')).status).toBe(400);
  });

  it('another tenant sees none of these books, even asking for this company', async () => {
    const other = await newTenant('Neighbour');
    const r = await trialBalance('2026-12-31', stubHeaders(other.tenantId, other.adminId));
    expect(r.status).toBe(200);
    expect(r.body.rows).toEqual([]);
  });

  it('every change to the ledger-bearing documents is in the audit log with who did it', async () => {
    const audit = await call(base, 'GET', '/audit?entity=document&limit=500', admin);
    expect(audit.body.length).toBeGreaterThan(10);
    expect(audit.body.every((a: { actorId: string }) => a.actorId && a.actorId !== NIL_USER)).toBe(
      true,
    );
  });
});
