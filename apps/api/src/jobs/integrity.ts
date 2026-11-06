import { uuidv7 } from '@erp/db';
import { NIL_USER, NIL_TENANT } from '../context/request-context.js';
import type { DatabaseService } from '../database/database.service.js';

export interface Difference {
  check_name: string;
  subject: string;
  expected: string;
  actual: string;
}

export interface TenantResult {
  tenantId: string;
  differences: number;
  detail: Difference[];
}

/** The tenants to visit. The registry holds only ids; the transaction carries the platform's nil tenant. */
export function listTenants(database: DatabaseService): Promise<string[]> {
  return database.withTenant({ tenantId: NIL_TENANT, userId: NIL_USER }, async (tx) =>
    (await tx.query<{ id: string }>('SELECT id FROM platform_tenant ORDER BY id')).map((r) => r.id),
  );
}

/**
 * Rebuilds stock balances, open-item remainders, journal sums and closed-period totals from the
 * ledgers and compares them with the stored values (PLAN.md rule 11). The result is recorded in
 * integrity_run either way, so a clean night is on file too.
 */
export function checkTenant(database: DatabaseService, tenantId: string): Promise<TenantResult> {
  return database.withTenant({ tenantId, userId: NIL_USER }, async (tx) => {
    const found = await tx.query<Difference & Record<string, unknown>>(
      'SELECT check_name, subject, expected, actual FROM public.integrity_check()',
    );
    await tx.query(
      'INSERT INTO integrity_run (tenant_id, id, differences, detail) VALUES ($1, $2, $3, $4)',
      [tenantId, uuidv7(), found.length, JSON.stringify(found.slice(0, 100))],
    );
    return { tenantId, differences: found.length, detail: found.slice(0, 100) };
  });
}
