import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Db, Tx } from '@erp/db';
import type { RequestContext } from '../context/request-context.js';
import { DB } from '../tokens.js';

/**
 * The API's only door to PostgreSQL. It exposes withTenant and nothing else: no pool, no client,
 * no query method. Tenant and user come from the request context, never from input.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  constructor(@Inject(DB) private readonly db: Db) {}

  withTenant<T>(ctx: RequestContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.withTenant(ctx.tenantId, ctx.userId, fn);
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.end();
  }
}
