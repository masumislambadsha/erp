import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';
import { UUID_RE } from './uuid7.js';

export class TenantContextError extends Error {
  override name = 'TenantContextError';
}

export type Row = Record<string, unknown>;

/** What a callback gets: typed CRUD through Drizzle, and raw SQL, both bound to one transaction. */
export interface Tx {
  readonly db: NodePgDatabase<typeof schema>;
  query<R extends Row = Row>(text: string, values?: unknown[]): Promise<R[]>;
  /** Like query, with the row count: what a job queue's database adapter needs. */
  execute(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number }>;
}

export interface Db {
  /**
   * The only way to reach the database. Opens a READ COMMITTED transaction (constraints keep
   * their defaults, so the kernel's deferred checks run at COMMIT), makes
   * `set_config('app.tenant_id', ...), set_config('app.user_id', ...)` its first statement,
   * runs `fn`, then commits, or rolls back if `fn` throws. The Tx dies when `fn` settles:
   * a leaked handle throws instead of borrowing a pooled connection.
   */
  withTenant<T>(tenantId: string, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export interface DbOptions {
  /** Connection string for the erp_app role. Never a superuser, erp_owner or a BYPASSRLS role. */
  connectionString: string;
  max?: number;
}

export function createDb(options: DbOptions): Db {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: 'erp-app',
  });
  // An idle client dropping must not crash the process.
  pool.on('error', () => {});

  return {
    async withTenant(tenantId, userId, fn) {
      assertUuid('tenantId', tenantId);
      assertUuid('userId', userId);
      const client = await pool.connect();
      let open = true;
      const guarded = {
        query: (...args: unknown[]) => {
          if (!open) {
            return Promise.reject(
              new TenantContextError('query after withTenant finished: the Tx handle is dead'),
            );
          }
          return (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
        },
      };
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
          [tenantId, userId],
        );
        const tx: Tx = {
          // drizzle only needs a `query` method; it never sees the real client.
          db: drizzle(guarded as unknown as pg.Client, { schema }),
          query: async (text, values) =>
            ((await guarded.query(text, values)) as pg.QueryResult).rows,
          execute: async (text, values) => {
            const r = (await guarded.query(text, values)) as pg.QueryResult;
            return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
          },
        };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw unwrapDrizzle(err);
      } finally {
        open = false;
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

function assertUuid(name: string, value: string): void {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new TenantContextError(`${name} must be a UUID`);
  }
}

/** Drizzle wraps driver errors in DrizzleQueryError; callers want the PostgreSQL error (code, constraint). */
function unwrapDrizzle(err: unknown): unknown {
  if (err instanceof Error && err.constructor.name === 'DrizzleQueryError' && err.cause)
    return err.cause;
  return err;
}
