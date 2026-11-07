import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { uuidv7 } from '@erp/db';
import { provisionTenantZero, type TenantZero } from '../src/cli/tenant-zero.js';
import { DatabaseService } from '../src/database/database.service.js';
import { checkTenant } from '../src/jobs/integrity.js';
import {
  addUser,
  ADMIN_URL,
  asPlatform,
  Browser,
  call,
  makeRole,
  PASSWORD,
  stubHeaders,
} from './support.js';

/**
 * Gives one tenant at least one row in EVERY table that carries tenant_id (except journal_check, which the
 * database empties at every COMMIT). Real flows where they are cheap (provisioning, sign-in, documents posting
 * through the kernel, the integrity check); fixtures through the kernel's own guards for the rest (stock, cost
 * layers, tax, dimensions, locks, rules). A table added later and missing here fails the isolation test.
 */
export async function seedTenantEverywhere(
  app: INestApplication,
  base: string,
  su: pg.Client,
  name: string,
): Promise<TenantZero & { adminHeaders: Record<string, string> }> {
  const tz = await provisionTenantZero(ADMIN_URL, {
    tenantName: name,
    adminEmail: `iso-${uuidv7()}@example.test`,
    adminName: 'Admin',
    adminPassword: PASSWORD,
  });
  const T = tz.tenantId;
  const admin = stubHeaders(T, tz.adminUserId);
  const key = () => ({ 'idempotency-key': `k-${uuidv7()}` });

  // Real flows: a party, a rent invoice and its receipt (journal, GL, open items, a settlement, numbering, idempotency, audit).
  const renter = (
    await call(base, 'POST', '/parties', admin, { name: 'Renter', tin: '123456789012' })
  ).body.id as string;
  const inv = await call(
    base,
    'POST',
    '/documents/rent_invoice',
    { ...admin, ...key() },
    {
      companyId: tz.companyId,
      postingDate: '2026-11-01',
      partyId: renter,
      values: {
        room: '1A',
        period_start: '2026-11-01',
        period_end: '2026-11-30',
        amount: '1000.00',
        due_date: '2026-11-10',
      },
    },
  );
  const sub = await call(base, 'POST', `/documents/rent_invoice/${inv.body.id}/submit`, {
    ...admin,
    ...key(),
  });
  const rct = await call(
    base,
    'POST',
    '/documents/rent_receipt',
    { ...admin, ...key() },
    {
      companyId: tz.companyId,
      postingDate: '2026-11-02',
      partyId: renter,
      values: { invoice: inv.body.id, amount: '400.00' },
    },
  );
  await call(base, 'POST', `/documents/rent_receipt/${rct.body.id}/submit`, { ...admin, ...key() });
  if (sub.status !== 200)
    throw new Error(`seed: invoice did not submit: ${JSON.stringify(sub.body)}`);

  // A document with a line.
  const def = {
    label: { en: 'Lined', bn: 'লাইন' },
    numbering: { prefix: 'LN-' },
    fields: [],
    lines: { minLines: 0, fields: [] },
  };
  await call(base, 'POST', '/meta/doc-types', admin, { docType: 'lined', definition: def });
  await call(
    base,
    'POST',
    '/documents/lined',
    { ...admin, ...key() },
    {
      companyId: tz.companyId,
      postingDate: '2026-11-01',
      values: {},
      lines: [{ qty: '2', uom: 'pcs' }],
    },
  );

  // Sign-in (a session and auth events) and the integrity check (integrity_run).
  const clerk = await addUser(su, T, ['rent_clerk']);
  const b = new Browser(base);
  const si = await b.signIn(T, clerk.email);
  if (si.status !== 200) throw new Error('seed: sign-in failed');
  await checkTenant(app.get(DatabaseService), T);

  // Fixtures through the kernel's guards.
  const id = {
    item: uuidv7(),
    wh: uuidv7(),
    sup: uuidv7(),
    cus: uuidv7(),
    inv: uuidv7(),
    grni: uuidv7(),
    cogs: uuidv7(),
    vat: uuidv7(),
    j3: uuidv7(),
    j4: uuidv7(),
    j5: uuidv7(),
  };
  const q = (text: string, v: unknown[] = []) => su.query(text, v);
  await asPlatform(su, T, async () => {
    for (const [aid, code, nm, kind, ctl] of [
      [id.inv, '1300', 'Inventory', 'asset', 'stock'],
      [id.grni, '2200', 'Received not billed', 'liability', null],
      [id.cogs, '5000', 'Cost of goods sold', 'expense', null],
    ] as const) {
      await q(
        'INSERT INTO account (tenant_id, id, company_id, code, name, kind, control_for) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [T, aid, tz.companyId, code, nm, kind, ctl],
      );
    }
    await q(
      "INSERT INTO account (tenant_id, id, company_id, code, name, kind, control_for, tax_code, tax_direction) VALUES ($1,$2,$3,'2300','VAT output','liability','tax','VAT','sale')",
      [T, id.vat, tz.companyId],
    );
    await q(
      "INSERT INTO item (tenant_id, id, sku, name, kind, base_uom, product_group, tax_category, valuation) VALUES ($1,$2,'FAN','Fan','stock','pcs','G','STD','fifo')",
      [T, id.item],
    );
    await q(
      "INSERT INTO uom_conversion (tenant_id, item_id, uom, factor) VALUES ($1,$2,'box',12)",
      [T, id.item],
    );
    await q(
      "INSERT INTO location (tenant_id, id, company_id, name, kind) VALUES ($1,$2,$5,'Warehouse','internal'), ($1,$3,$5,'Suppliers','supplier'), ($1,$4,$5,'Customers','customer')",
      [T, id.wh, id.sup, id.cus, tz.companyId],
    );
    await q(
      "INSERT INTO party_role (tenant_id, party_id, company_id, role, posting_group, tax_group) VALUES ($1,$2,$3,'customer','RES','STD')",
      [T, renter, tz.companyId],
    );
    await q("INSERT INTO tenant_pack (tenant_id, pack_id, version) VALUES ($1,'rental','1.0')", [
      T,
    ]);
    await q('INSERT INTO dimension_set (tenant_id, dims) VALUES ($1, \'{"cost_center":"A"}\')', [
      T,
    ]);
    await q(
      "INSERT INTO tax_rule (tenant_id, company_id, direction, tax_category, tax_code, valid_from, rate, account_id) VALUES ($1,$2,'sale','STD','VAT','2026-07-01',0.15,$3)",
      [T, tz.companyId, id.vat],
    );
    await q(
      "INSERT INTO role_record_rule (tenant_id, id, role_id, entity, company_id) SELECT $1, $2, id, 'account', $3 FROM role WHERE tenant_id = $1 AND name = 'rent_clerk'",
      [T, uuidv7(), tz.companyId],
    );
    await q(
      "INSERT INTO role_field_rule (tenant_id, id, role_id, entity, field, access) SELECT $1, $2, id, 'party', 'tin', 'hidden' FROM role WHERE tenant_id = $1 AND name = 'rent_clerk'",
      [T, uuidv7()],
    );
    const journal = (j: string, date: string) =>
      q(
        "INSERT INTO journal (tenant_id, id, company_id, posting_date, kind) VALUES ($1,$2,$3,$4,'post')",
        [T, j, tz.companyId, date],
      );
    const gl = (
      j: string,
      date: string,
      account: string,
      amount: number,
      item: string | null = null,
    ) =>
      q(
        "INSERT INTO gl_line (tenant_id, journal_id, company_id, posting_date, account_id, amount, currency, amount_tc, item_id) VALUES ($1,$2,$3,$4,$5,$6,'BDT',$6,$7)",
        [T, j, tz.companyId, date, account, amount, item],
      );
    // A stock receipt (move, value entry, balance, a cost layer) and a delivery that consumes part of it (cost application).
    await journal(id.j3, '2026-06-15');
    const m1 = (
      await q(
        "INSERT INTO stock_move (tenant_id, journal_id, company_id, posting_date, item_id, from_location, to_location, base_qty) VALUES ($1,$2,$3,'2026-06-15',$4,$5,$6,10) RETURNING id",
        [T, id.j3, tz.companyId, id.item, id.sup, id.wh],
      )
    ).rows[0].id;
    await q(
      "INSERT INTO stock_value_entry (tenant_id, journal_id, company_id, posting_date, item_id, location_id, account_id, move_date, move_id, qty, cost, kind) VALUES ($1,$2,$3,'2026-06-15',$4,$5,$6,'2026-06-15',$7,10,1000,'direct')",
      [T, id.j3, tz.companyId, id.item, id.wh, id.inv, m1],
    );
    await gl(id.j3, '2026-06-15', id.inv, 1000, id.item);
    await gl(id.j3, '2026-06-15', id.grni, -1000);
    await q(
      "INSERT INTO cost_layer (tenant_id, id, company_id, item_id, source_move_date, source_move_id, in_qty, remaining_qty, unit_cost) VALUES ($1,$2,$3,$4,'2026-06-15',$5,10,7,100)",
      [T, uuidv7(), tz.companyId, id.item, m1],
    );
    await journal(id.j4, '2026-06-20');
    const m2 = (
      await q(
        "INSERT INTO stock_move (tenant_id, journal_id, company_id, posting_date, item_id, from_location, to_location, base_qty) VALUES ($1,$2,$3,'2026-06-20',$4,$5,$6,3) RETURNING id",
        [T, id.j4, tz.companyId, id.item, id.wh, id.cus],
      )
    ).rows[0].id;
    await q(
      "INSERT INTO stock_value_entry (tenant_id, journal_id, company_id, posting_date, item_id, location_id, account_id, move_date, move_id, qty, cost, kind) VALUES ($1,$2,$3,'2026-06-20',$4,$5,$6,'2026-06-20',$7,-3,-300,'direct')",
      [T, id.j4, tz.companyId, id.item, id.wh, id.inv, m2],
    );
    await gl(id.j4, '2026-06-20', id.cogs, 300);
    await gl(id.j4, '2026-06-20', id.inv, -300, id.item);
    await q(
      "INSERT INTO cost_application (tenant_id, journal_id, company_id, posting_date, item_id, out_move_date, out_move_id, in_move_date, in_move_id, qty) VALUES ($1,$2,$3,'2026-06-20',$4,'2026-06-20',$5,'2026-06-15',$6,3)",
      [T, id.j4, tz.companyId, id.item, m2, m1],
    );
    // A tax adjustment (the VAT register).
    await journal(id.j5, '2026-06-25');
    await gl(id.j5, '2026-06-25', tz.accounts.cash, 150);
    await gl(id.j5, '2026-06-25', id.vat, -150);
    await q(
      "INSERT INTO tax_line (tenant_id, journal_id, company_id, posting_date, kind, direction, tax_code, rate, currency, base_amount, tax_amount, tax_amount_tc, account_id) VALUES ($1,$2,$3,'2026-06-25','adjustment','sale','VAT',0.15,'BDT',-1000,-150,-150,$4)",
      [T, id.j5, tz.companyId, id.vat],
    );
    // Close June: frozen totals, then the lock.
    await q(
      "INSERT INTO period_balance (tenant_id, company_id, account_id, period_end, amount) VALUES ($1,$2,$3,'2026-06-30',-150)",
      [T, tz.companyId, id.vat],
    );
    await q(
      "INSERT INTO posting_lock (tenant_id, company_id, ledger, locked_through) VALUES ($1,$2,'gl','2026-06-30')",
      [T, tz.companyId],
    );
  });
  void makeRole;
  return { ...tz, adminHeaders: admin };
}
