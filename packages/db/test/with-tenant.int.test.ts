import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as publicApi from '../src/index.js';
import { createDb, eq, schema, TenantContextError, uuidv7, type Db } from '../src/index.js';
import { admin, env } from './helpers.js';

const { party } = schema;
const tenantA = uuidv7();
const tenantB = uuidv7();
const userA = uuidv7();
const partyA = uuidv7();
const partyB = uuidv7();
let db: Db;
let su: pg.Client;

beforeAll(async () => {
  db = createDb({ connectionString: env('DATABASE_URL'), max: 4 });
  su = await admin();
  for (const [t, name] of [
    [tenantA, 'Tenant A'],
    [tenantB, 'Tenant B'],
  ] as const) {
    await su.query('INSERT INTO tenant (id, name) VALUES ($1, $2)', [t, name]);
  }
  // The audit trigger reads app.user_id, so even a superuser seeds with the same context the app sets.
  for (const [t, id, name] of [
    [tenantA, partyA, 'A Customer'],
    [tenantB, partyB, 'B Customer'],
  ] as const) {
    await su.query('BEGIN');
    await su.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [t, userA],
    );
    await su.query('INSERT INTO party (tenant_id, id, name) VALUES ($1, $2, $3)', [t, id, name]);
    await su.query('COMMIT');
  }
});

afterAll(async () => {
  await db.end();
  await su.query('SET session_replication_role = replica'); // cleanup only; superuser, never the app
  await su
    .query('DELETE FROM party WHERE tenant_id = ANY($1)', [[tenantA, tenantB]])
    .catch(() => {});
  await su.end();
});

describe('withTenant', () => {
  it('opens a READ COMMITTED transaction whose first statement sets tenant and user', async () => {
    const row = await db.withTenant(tenantA, userA, async (tx) => {
      const [r] = await tx.query<{ t: string; u: string; iso: string }>(
        `SELECT current_setting('app.tenant_id') t, current_setting('app.user_id') u,
                current_setting('transaction_isolation') iso`,
      );
      return r!;
    });
    expect(row.t).toBe(tenantA);
    expect(row.u).toBe(userA);
    expect(row.iso).toBe('read committed');
  });

  it('does not leak one transaction’s tenant into the next on a pooled connection', async () => {
    const seen: string[] = [];
    for (const t of [tenantA, tenantB, tenantA, tenantB]) {
      await db.withTenant(t, userA, async (tx) => {
        const rows = await tx.db.select().from(party);
        seen.push(rows.map((r) => r.tenantId).join(','));
      });
    }
    expect(seen).toEqual([tenantA, tenantB, tenantA, tenantB]);
  });

  it('tenant A cannot read tenant B’s rows', async () => {
    await db.withTenant(tenantA, userA, async (tx) => {
      expect(await tx.db.select().from(party).where(eq(party.id, partyB))).toEqual([]);
      expect((await tx.db.select().from(party)).map((r) => r.id)).toEqual([partyA]);
    });
  });

  it('tenant A cannot update or delete tenant B’s rows', async () => {
    await db.withTenant(tenantA, userA, async (tx) => {
      expect(
        await tx.db.update(party).set({ name: 'pwned' }).where(eq(party.id, partyB)).returning(),
      ).toEqual([]);
      expect(await tx.db.delete(party).where(eq(party.id, partyB)).returning()).toEqual([]);
    });
    const { rows } = await su.query('SELECT name FROM party WHERE id = $1', [partyB]);
    expect(rows).toEqual([{ name: 'B Customer' }]);
  });

  it('tenant A cannot write a row into tenant B', async () => {
    await expect(
      db.withTenant(tenantA, userA, (tx) =>
        tx.db.insert(party).values({ tenantId: tenantB, id: uuidv7(), name: 'planted' }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('rolls back when the callback throws', async () => {
    const id = uuidv7();
    await expect(
      db.withTenant(tenantA, userA, async (tx) => {
        await tx.db.insert(party).values({ tenantId: tenantA, id, name: 'temp' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await su.query('SELECT 1 FROM party WHERE id = $1', [id]);
    expect(rows).toEqual([]);
  });

  it('commits when the callback returns', async () => {
    const id = uuidv7();
    await db.withTenant(tenantA, userA, (tx) =>
      tx.db.insert(party).values({ tenantId: tenantA, id, name: 'kept' }),
    );
    const { rows } = await su.query('SELECT name FROM party WHERE id = $1', [id]);
    expect(rows).toEqual([{ name: 'kept' }]);
  });

  it('rejects a malformed tenant or user before touching the database', async () => {
    await expect(db.withTenant('not-a-uuid', userA, async () => 1)).rejects.toThrow(
      TenantContextError,
    );
    await expect(db.withTenant(tenantA, "x'; DROP TABLE party;--", async () => 1)).rejects.toThrow(
      TenantContextError,
    );
    await expect(db.withTenant('', userA, async () => 1)).rejects.toThrow(TenantContextError);
  });
});

describe('a query outside withTenant fails', () => {
  it('a Tx kept past the callback is dead, for raw SQL and for drizzle', async () => {
    let leaked: Parameters<Parameters<Db['withTenant']>[2]>[0] | undefined;
    await db.withTenant(tenantA, userA, async (tx) => {
      leaked = tx;
    });
    await expect(leaked!.query('SELECT 1')).rejects.toThrow(TenantContextError);
    await expect(leaked!.db.select().from(party)).rejects.toMatchObject({
      cause: { name: 'TenantContextError' },
    }); // drizzle wraps it
  });

  it('the package exports no pool, client or raw query function', () => {
    expect(Object.keys(publicApi).sort()).toEqual(
      [
        'Money',
        'MONEY_SCALE',
        'TenantContextError',
        'UUID_RE',
        'and',
        'asc',
        'createDb',
        'createUuidV7Generator',
        'desc',
        'eq',
        'or',
        'schema',
        'sql',
        'uuidv7',
        'uuidv7Time',
      ].sort(),
    );
  });

  it('the database itself refuses erp_app a query with no tenant context', async () => {
    const raw = new pg.Client({ connectionString: env('DATABASE_URL') });
    await raw.connect();
    try {
      await expect(raw.query('SELECT * FROM party')).rejects.toThrow(
        /app\.tenant_id|invalid input syntax for type uuid/,
      );
      // Even after a transaction that did set it: set_config(..., true) ends with the transaction.
      await raw.query('BEGIN');
      await raw.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      await raw.query('COMMIT');
      await expect(raw.query('SELECT * FROM party')).rejects.toThrow(
        /app\.tenant_id|invalid input syntax for type uuid/,
      );
      await expect(
        raw.query('INSERT INTO party (tenant_id, id, name) VALUES ($1, $2, $3)', [
          tenantA,
          uuidv7(),
          'x',
        ]),
      ).rejects.toThrow();
    } finally {
      await raw.end();
    }
  });

  it('connects as erp_app: not a superuser, no BYPASSRLS', async () => {
    const [r] = await db.withTenant(tenantA, userA, (tx) =>
      tx.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      ),
    );
    expect(r).toEqual({ rolname: 'erp_app', rolsuper: false, rolbypassrls: false });
  });
});

describe('drizzle tables mirror the migrated schema', () => {
  it.each(Object.entries(schema))('%s', async (_name, table) => {
    const cfg = getTableConfig(table as PgTable);
    const { rows } = await su.query<{ column_name: string; is_nullable: string }>(
      'SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      ['public', cfg.name],
    );
    const db = Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable === 'NO']));
    const ts = Object.fromEntries(cfg.columns.map((c) => [c.name, c.notNull]));
    expect(ts).toEqual(db);
  });
});
