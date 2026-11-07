import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import { seedTenantEverywhere } from './isolation-fixture.js';
import { startApp, superuser } from './support.js';

/**
 * The isolation suite over EVERY table that carries tenant_id. Tenant A is seeded so that each such table
 * holds an A row (the test fails if one does not, so a new table must be added to the fixture). Then, as
 * erp_app inside tenant B: SELECT finds nothing; UPDATE and DELETE change nothing (zero rows or permission
 * denied); inserting a tenant-A row fails for the reason isolation gives (row-level security or privilege).
 */
const EXEMPT = new Map([
  [
    'journal_check',
    'the database empties it at every COMMIT; erp_app has no privilege on it (kernel tests H09, K01)',
  ],
]);

let app: INestApplication;
let base: string;
let su: pg.Client;
let database: DatabaseService;
let A: Awaited<ReturnType<typeof seedTenantEverywhere>>;
let B: Awaited<ReturnType<typeof seedTenantEverywhere>>;
let tables: string[] = [];

beforeAll(async () => {
  ({ app, base } = await startApp());
  su = await superuser();
  database = app.get(DatabaseService);
  A = await seedTenantEverywhere(app, base, su, 'Isolation A');
  B = await seedTenantEverywhere(app, base, su, 'Isolation B');
  tables = (
    await su.query<{
      relname: string;
    }>(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('information_schema') AND n.nspname NOT LIKE 'pg\\_%' AND c.relkind IN ('r','p') AND NOT c.relispartition
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
        ORDER BY 1`)
  ).rows.map((r) => r.relname);
}, 120_000);
afterAll(async () => {
  await app?.close();
  await su?.end();
});

const REASON = /row-level security|permission denied/;
/**
 * A ledger row or a line cites a journal or document; from tenant B that journal or document does not exist, so
 * the kernel's own guard refuses first ("sealed or missing"). That refusal is the tenant boundary at work, and these
 * tables are the only ones allowed it. Every other table must be refused by RLS or by privilege.
 */
const GUARD_FIRST = new Map<string, RegExp>(
  [
    'cost_application',
    'gl_line',
    'open_item',
    'settlement',
    'stock_move',
    'stock_value_entry',
    'tax_line',
  ]
    .map((t) => [t, /is sealed or missing/] as [string, RegExp])
    .concat([['document_line', /lines of a missing document/]]),
);
const asB = <T>(
  fn: (
    q: (
      text: string,
      v?: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>,
  ) => Promise<T>,
) =>
  database.withTenant({ tenantId: B.tenantId, userId: B.adminUserId }, (tx) =>
    fn((text, v) => tx.execute(text, v)),
  );
const countA = async (t: string) =>
  Number(
    (await su.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id = $1`, [A.tenantId])).rows[0]
      .n,
  );

describe('tenant A is seeded in every table', () => {
  it('finds the tables from the catalog, and has an A row in each (so a new table must be covered)', async () => {
    expect(tables.length).toBeGreaterThanOrEqual(40);
    const missing: string[] = [];
    for (const t of tables) if (!EXEMPT.has(t) && (await countA(t)) === 0) missing.push(t);
    expect(
      missing,
      `no tenant-A row in: ${missing.join(', ')}. Add one to test/isolation-fixture.ts.`,
    ).toEqual([]);
  });
});

describe('as erp_app in tenant B, tenant A is out of reach in every table', () => {
  it('SELECT finds nothing', async () => {
    const failures: string[] = [];
    for (const t of tables) {
      try {
        const n = await asB(async (q) =>
          Number(
            (await q(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [A.tenantId]))
              .rows[0]!.n,
          ),
        );
        if (n !== 0) failures.push(`${t}: saw ${n} tenant-A rows`);
      } catch (e) {
        if (!REASON.test((e as Error).message)) failures.push(`${t}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('SELECT without a tenant filter returns only tenant B rows', async () => {
    const failures: string[] = [];
    for (const t of tables) {
      try {
        const rows = await asB(async (q) => (await q(`SELECT DISTINCT tenant_id FROM ${t}`)).rows);
        if (rows.some((r) => r.tenant_id !== B.tenantId))
          failures.push(`${t}: rows of another tenant are visible`);
      } catch (e) {
        if (!REASON.test((e as Error).message)) failures.push(`${t}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('UPDATE changes nothing: zero rows, or permission denied', async () => {
    const failures: string[] = [];
    const before = new Map<string, number>();
    for (const t of tables) before.set(t, await countA(t));
    for (const t of tables) {
      try {
        const n = await asB(
          async (q) =>
            (await q(`UPDATE ${t} SET tenant_id = tenant_id WHERE tenant_id = $1`, [A.tenantId]))
              .rowCount,
        );
        if (n !== 0) failures.push(`${t}: updated ${n} tenant-A rows`);
      } catch (e) {
        if (!REASON.test((e as Error).message)) failures.push(`${t}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
    for (const t of tables) expect(await countA(t), t).toBe(before.get(t));
  });

  it('DELETE changes nothing: zero rows, or permission denied', async () => {
    const failures: string[] = [];
    const before = new Map<string, number>();
    for (const t of tables) before.set(t, await countA(t));
    for (const t of tables) {
      try {
        const n = await asB(
          async (q) => (await q(`DELETE FROM ${t} WHERE tenant_id = $1`, [A.tenantId])).rowCount,
        );
        if (n !== 0) failures.push(`${t}: deleted ${n} tenant-A rows`);
      } catch (e) {
        if (!REASON.test((e as Error).message)) failures.push(`${t}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
    for (const t of tables) expect(await countA(t), t).toBe(before.get(t));
  });

  it('inserting a tenant-A row fails, and adds nothing', async () => {
    const failures: string[] = [];
    for (const t of tables) {
      // A real tenant-A row, so a failure cannot be put down to a missing column or a bad value.
      const cols = (
        await su.query<{
          column_name: string;
          is_generated: string;
          identity_generation: string | null;
        }>(
          "SELECT column_name, is_generated, identity_generation FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
          [t],
        )
      ).rows.filter((c) => c.is_generated !== 'ALWAYS');
      const list = cols.map((c) => `"${c.column_name}"`).join(', ');
      const row = (
        await su.query(`SELECT to_jsonb(x) AS j FROM ${t} x WHERE tenant_id = $1 LIMIT 1`, [
          A.tenantId,
        ])
      ).rows[0]?.j;
      if (!row) continue; // exempt tables (journal_check) have none; the first test names any other
      // A document is born a draft (the kernel insists); make the copy one so the refusal that matters is the tenant's.
      if (t === 'document')
        Object.assign(row, {
          status: 'draft',
          number: null,
          submitted_at: null,
          issued_at: null,
          party_snapshot: null,
        });
      const before = await countA(t);
      try {
        await asB((q) =>
          q(
            `INSERT INTO ${t} (${list}) OVERRIDING SYSTEM VALUE SELECT ${list} FROM jsonb_populate_record(NULL::${t}, $1::jsonb)`,
            [JSON.stringify(row)],
          ),
        );
        failures.push(`${t}: the insert succeeded`);
      } catch (e) {
        const msg = (e as Error).message;
        if (!REASON.test(msg) && !GUARD_FIRST.get(t)?.test(msg))
          failures.push(`${t}: failed, but not for isolation: ${msg}`);
      }
      if ((await countA(t)) !== before) failures.push(`${t}: the tenant-A row count changed`);
    }
    expect(failures).toEqual([]);
  });

  it('and the exempt tables are named, with a reason', () => {
    expect([...EXEMPT.keys()]).toEqual(['journal_check']);
  });
});

describe("the reverse holds too: tenant B cannot reach tenant A from tenant A's side", () => {
  it('each tenant sees only its own rows in the busiest tables', async () => {
    for (const t of ['document', 'journal', 'gl_line', 'party', 'audit_log', 'role']) {
      const rows = await database.withTenant(
        { tenantId: A.tenantId, userId: A.adminUserId },
        (tx) => tx.query(`SELECT DISTINCT tenant_id FROM ${t}`),
      );
      expect(
        rows.every((r) => r.tenant_id === A.tenantId),
        t,
      ).toBe(true);
    }
  });
});
