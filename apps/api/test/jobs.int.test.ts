import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { NIL_USER } from '../src/context/request-context.js';
import { DatabaseService } from '../src/database/database.service.js';
import { checkTenant, listTenants } from '../src/jobs/integrity.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import { QUEUES } from '../src/jobs/queues.js';
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
let jobs: JobsService;
let database: DatabaseService;
let tenantId: string;

const until = async <T>(
  fn: () => Promise<T | null | undefined | false>,
  ms = 15_000,
): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 200));
  }
};
const jobState = async (queue: string, key: string, value: string) =>
  (
    await su.query('SELECT state FROM pgboss.job WHERE name = $1 AND data->>$2 = $3', [
      queue,
      key,
      value,
    ])
  ).rows[0]?.state as string | undefined;

beforeAll(async () => {
  ({ app, base } = await startApp({ JOBS_ENABLED: 'true' }));
  su = await superuser();
  jobs = app.get(JobsService);
  database = app.get(DatabaseService);
  tenantId = (await newTenant('Jobs')).tenantId;
});
afterAll(async () => {
  await app?.close();
  await su?.end();
});

describe('jobs are enqueued inside the transaction', () => {
  it('a rolled-back transaction leaves no job; a committed one leaves exactly one, which a worker runs', async () => {
    const lost = uuidv7();
    await expect(
      database.withTenant({ tenantId, userId: NIL_USER }, async (tx) => {
        await jobs.enqueueIn(tx, QUEUES.documentSubmitted, {
          tenantId,
          docType: 'x',
          documentId: lost,
          submittedBy: NIL_USER,
        });
        throw new Error('the submit failed after queueing');
      }),
    ).rejects.toThrow('the submit failed');
    expect(await jobState(QUEUES.documentSubmitted, 'documentId', lost)).toBeUndefined();

    const kept = uuidv7();
    await database.withTenant({ tenantId, userId: NIL_USER }, (tx) =>
      jobs.enqueueIn(tx, QUEUES.documentSubmitted, {
        tenantId,
        docType: 'x',
        documentId: kept,
        submittedBy: NIL_USER,
      }),
    );
    expect(
      await until(() =>
        jobState(QUEUES.documentSubmitted, 'documentId', kept).then((s) => s === 'completed' && s),
      ),
    ).toBe('completed');
    expect(
      (
        await su.query("SELECT count(*)::int n FROM pgboss.job WHERE data->>'documentId' = $1", [
          kept,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it('submitting a document queues its event in the same transaction, and the worker handles it', async () => {
    const t = await newTenant('Jobs submit');
    const company = await addCompany(su, t.tenantId);
    const admin = stubHeaders(t.tenantId, t.adminId);
    const def = { label: { en: 'T', bn: 'T' }, numbering: { prefix: 'T-' }, fields: [] };
    await call(base, 'POST', '/meta/doc-types', admin, { docType: 'ticket', definition: def });
    await makeRole(su, t.tenantId, 'tmaker', ['ticket:create']);
    const maker = stubHeaders(t.tenantId, (await addUser(su, t.tenantId, ['tmaker'])).id);
    const k = () => ({ 'idempotency-key': `k-${uuidv7()}` });
    const d = await call(
      base,
      'POST',
      '/documents/ticket',
      { ...maker, ...k() },
      { companyId: company, postingDate: '2026-11-01', values: {} },
    );
    expect(d.status).toBe(201);
    expect(await jobState(QUEUES.documentSubmitted, 'documentId', d.body.id)).toBeUndefined(); // a draft queues nothing
    const s = await call(base, 'POST', `/documents/ticket/${d.body.id}/submit`, {
      ...admin,
      ...k(),
    });
    expect(s.status).toBe(200);
    expect(
      await until(() =>
        jobState(QUEUES.documentSubmitted, 'documentId', d.body.id).then(
          (x) => x === 'completed' && x,
        ),
      ),
    ).toBe('completed');
    // A refused submit queues nothing.
    const again = await call(base, 'POST', `/documents/ticket/${d.body.id}/submit`, {
      ...admin,
      ...k(),
    });
    expect(again.status).toBe(409);
    expect(
      (
        await su.query(
          "SELECT count(*)::int n FROM pgboss.job WHERE name = $1 AND data->>'documentId' = $2",
          [QUEUES.documentSubmitted, d.body.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
});

describe('the nightly integrity check', () => {
  const KEYS = [
    'company',
    'cash',
    'ar',
    'inv',
    'grni',
    'sales',
    'party',
    'item',
    'wh',
    'sup',
    'j1',
    'j2',
    'j3',
    'oi1',
    'oi2',
  ] as const;
  const ids = Object.fromEntries(KEYS.map((k) => [k, uuidv7()])) as Record<
    (typeof KEYS)[number],
    string
  >;
  let itenant: string;

  /** A small set of real books, posted through the kernel's own guards (the COMMIT checks run): an invoice, its payment and settlement, and a stock receipt, with June closed. */
  beforeAll(async () => {
    itenant = (await newTenant('Integrity')).tenantId;
    const T = itenant;
    const q = (text: string, values: unknown[] = []) => su.query(text, values);
    await asPlatform(su, T, async () => {
      await q('INSERT INTO company (tenant_id, id, name, base_currency) VALUES ($1,$2,$3,$4)', [
        T,
        ids.company,
        'Co',
        'BDT',
      ]);
      for (const [id, code, name, kind, ctl] of [
        [ids.cash, '1010', 'Cash', 'asset', null],
        [ids.ar, '1200', 'Receivables', 'asset', 'receivable'],
        [ids.inv, '1300', 'Inventory', 'asset', 'stock'],
        [ids.grni, '2200', 'Received not billed', 'liability', null],
        [ids.sales, '4000', 'Sales', 'income', null],
      ] as const) {
        await q(
          'INSERT INTO account (tenant_id, id, company_id, code, name, kind, control_for) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [T, id, ids.company, code, name, kind, ctl],
        );
      }
      await q("INSERT INTO party (tenant_id, id, name) VALUES ($1,$2,'Rahim Store')", [
        T,
        ids.party,
      ]);
      await q(
        "INSERT INTO item (tenant_id, id, sku, name, kind, base_uom, product_group, tax_category, valuation) VALUES ($1,$2,'FAN','Fan','stock','pcs','G','S','fifo')",
        [T, ids.item],
      );
      await q(
        "INSERT INTO location (tenant_id, id, company_id, name, kind) VALUES ($1,$2,$3,'Warehouse','internal'), ($1,$4,$3,'Suppliers','supplier')",
        [T, ids.wh, ids.company, ids.sup],
      );
    });
    await asPlatform(su, T, async () => {
      const journal = (id: string, date: string) =>
        q(
          "INSERT INTO journal (tenant_id, id, company_id, posting_date, kind) VALUES ($1,$2,$3,$4,'post')",
          [T, id, ids.company, date],
        );
      const gl = (
        j: string,
        date: string,
        account: string,
        amount: number,
        party: string | null = null,
        item: string | null = null,
      ) =>
        q(
          "INSERT INTO gl_line (tenant_id, journal_id, company_id, posting_date, account_id, amount, currency, amount_tc, party_id, item_id) VALUES ($1,$2,$3,$4,$5,$6,'BDT',$6,$7,$8)",
          [T, j, ids.company, date, account, amount, party, item],
        );
      const openItem = (id: string, j: string, date: string, amount: number) =>
        q(
          "INSERT INTO open_item (tenant_id, id, journal_id, company_id, posting_date, party_id, side, account_id, due_date, currency, amount, amount_tc, remaining, remaining_tc) VALUES ($1,$2,$3,$4,$5,$6,'receivable',$7,$5,'BDT',$8,$8,$8,$8)",
          [T, id, j, ids.company, date, ids.party, ids.ar, amount],
        );
      await journal(ids.j1, '2026-06-10');
      await gl(ids.j1, '2026-06-10', ids.ar, 700, ids.party);
      await gl(ids.j1, '2026-06-10', ids.sales, -700);
      await openItem(ids.oi1, ids.j1, '2026-06-10', 700);
      await journal(ids.j2, '2026-06-12');
      await gl(ids.j2, '2026-06-12', ids.cash, 700);
      await gl(ids.j2, '2026-06-12', ids.ar, -700, ids.party);
      await openItem(ids.oi2, ids.j2, '2026-06-12', -700);
      await q(
        "INSERT INTO settlement (tenant_id, journal_id, company_id, posting_date, kind, debit_item_id, credit_item_id, amount, amount_tc) VALUES ($1,$2,$3,'2026-06-12','apply',$4,$5,700,700)",
        [T, ids.j2, ids.company, ids.oi1, ids.oi2],
      );
      await journal(ids.j3, '2026-06-15');
      const mv = await q(
        "INSERT INTO stock_move (tenant_id, journal_id, company_id, posting_date, item_id, from_location, to_location, base_qty) VALUES ($1,$2,$3,'2026-06-15',$4,$5,$6,10) RETURNING id",
        [T, ids.j3, ids.company, ids.item, ids.sup, ids.wh],
      );
      await q(
        "INSERT INTO stock_value_entry (tenant_id, journal_id, company_id, posting_date, item_id, location_id, account_id, move_date, move_id, qty, cost, kind) VALUES ($1,$2,$3,'2026-06-15',$4,$5,$6,'2026-06-15',$7,10,1000,'direct')",
        [T, ids.j3, ids.company, ids.item, ids.wh, ids.inv, mv.rows[0].id],
      );
      await gl(ids.j3, '2026-06-15', ids.inv, 1000, null, ids.item);
      await gl(ids.j3, '2026-06-15', ids.grni, -1000);
      // Close June: the frozen totals, then the lock.
      for (const [account, amount] of [
        [ids.cash, 700],
        [ids.sales, -700],
        [ids.inv, 1000],
        [ids.grni, -1000],
      ] as const) {
        await q(
          "INSERT INTO period_balance (tenant_id, company_id, account_id, period_end, amount) VALUES ($1,$2,$3,'2026-06-30',$4)",
          [T, ids.company, account, amount],
        );
      }
      await q(
        "INSERT INTO posting_lock (tenant_id, company_id, ledger, locked_through) VALUES ($1,$2,'gl','2026-06-30')",
        [T, ids.company],
      );
    });
  });

  it('finds nothing wrong in books the kernel accepted, and files the result', async () => {
    const r = await checkTenant(database, itenant);
    expect(r).toMatchObject({ tenantId: itenant, differences: 0, detail: [] });
    const runs = await su.query('SELECT differences FROM integrity_run WHERE tenant_id = $1', [
      itenant,
    ]);
    expect(runs.rows).toEqual([{ differences: 0 }]);
  });

  it('sees the registry: every tenant, and only ids', async () => {
    expect(await listTenants(database)).toContain(itenant);
    await expect(
      database.withTenant({ tenantId: itenant, userId: NIL_USER }, (tx) =>
        tx.query('INSERT INTO platform_tenant (id) VALUES ($1)', [uuidv7()]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('rebuilds balances from the ledgers and reports each difference when stored values drift', async () => {
    // Simulate corruption the way a bug or a bad restore would: write derived state behind the guards.
    await su.query('BEGIN');
    await su.query('SET LOCAL session_replication_role = replica');
    await su.query('UPDATE stock_balance SET on_hand = 9 WHERE tenant_id = $1', [itenant]);
    await su.query('UPDATE open_item SET remaining = 700, remaining_tc = 700 WHERE id = $1', [
      ids.oi1,
    ]);
    await su.query(
      'UPDATE period_balance SET amount = -600 WHERE tenant_id = $1 AND account_id = $2',
      [itenant, ids.sales],
    );
    await su.query('COMMIT');
    const r = await checkTenant(database, itenant);
    const by = (name: string) => r.detail.filter((d) => d.check_name === name);
    expect(by('stock_balance')).toEqual([
      expect.objectContaining({ expected: '10.000000', actual: '9.000000' }),
    ]);
    expect(by('open_item.remaining')).toEqual([
      expect.objectContaining({ subject: ids.oi1, expected: '0.0000', actual: '700.0000' }),
    ]);
    expect(by('open_item.remaining_tc')).toHaveLength(1);
    expect(by('period_balance')).toEqual([
      expect.objectContaining({ expected: '-700.0000', actual: '-600.0000' }),
    ]);
    expect(r.differences).toBe(4);
    expect(by('journal.balance')).toEqual([]);

    // And an unbalanced journal is caught too.
    await su.query('BEGIN');
    await su.query('SET LOCAL session_replication_role = replica');
    await su.query(
      'UPDATE gl_line SET amount = -699 WHERE tenant_id = $1 AND journal_id = $2 AND account_id = $3',
      [itenant, ids.j1, ids.sales],
    );
    await su.query('COMMIT');
    const r2 = await checkTenant(database, itenant);
    expect(r2.detail.filter((d) => d.check_name === 'journal.balance')).toEqual([
      expect.objectContaining({ subject: ids.j1, actual: '1.0000' }),
    ]);
  });

  it('runs as a job once per Dhaka day, over every tenant, and records what it finds', async () => {
    const day = new Date(
      Date.UTC(
        2100 + Math.floor(Math.random() * 300),
        Math.floor(Math.random() * 12),
        1 + Math.floor(Math.random() * 27),
        22,
        30,
      ),
    ); // 04:30 next day in Dhaka
    const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(day);
    await jobs.tick(day);
    await jobs.tick(day); // the second tick the same day does nothing
    const rows = await until(async () => {
      const r = await su.query(
        'SELECT state FROM pgboss.job WHERE name = $1 AND singleton_key = $2',
        [QUEUES.integrityNightly, dayKey],
      );
      return r.rows[0]?.state === 'completed' ? r.rows : null;
    }, 30_000);
    expect(rows[0].state).toBe('completed');
    expect(
      (
        await su.query(
          'SELECT count(*)::int n FROM pgboss.job WHERE name = $1 AND singleton_key = $2',
          [QUEUES.integrityNightly, dayKey],
        )
      ).rows[0].n,
    ).toBe(1); // once per day
    const runs = await su.query(
      'SELECT differences FROM integrity_run WHERE tenant_id = $1 ORDER BY at DESC LIMIT 1',
      [itenant],
    );
    expect(runs.rows[0].differences).toBeGreaterThan(0); // the drifted books were found by the job itself
  });

  it('does not run before 02:00 in Dhaka', async () => {
    const before = (
      await su.query('SELECT count(*)::int n FROM pgboss.job WHERE name = $1', [
        QUEUES.integrityNightly,
      ])
    ).rows[0].n;
    await jobs.tick(new Date(Date.UTC(2400, 0, 5, 19, 59))); // 01:59 in Dhaka
    expect(
      (
        await su.query('SELECT count(*)::int n FROM pgboss.job WHERE name = $1', [
          QUEUES.integrityNightly,
        ])
      ).rows[0].n,
    ).toBe(before);
  });
});

describe('housekeeping', () => {
  it('deletes finished jobs past retention and reports stuck ones', async () => {
    await su.query(
      "INSERT INTO pgboss.job (name, state, keep_until, completed_on, data) VALUES ($1, 'completed', now() - interval '1 day', now() - interval '2 days', '{\"old\":true}')",
      [QUEUES.maintenance],
    );
    await su.query(
      "INSERT INTO pgboss.job (name, state, started_on, expire_seconds, data) VALUES ($1, 'active', now() - interval '1 hour', 900, '{\"stuck\":true}')",
      [QUEUES.maintenance],
    );
    const r = await jobs.maintain();
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(r.stuck).toBeGreaterThanOrEqual(1);
    expect(
      (await su.query("SELECT count(*)::int n FROM pgboss.job WHERE data->>'old' = 'true'")).rows[0]
        .n,
    ).toBe(0);
    await su.query("DELETE FROM pgboss.job WHERE data->>'stuck' = 'true'");
  });
});
