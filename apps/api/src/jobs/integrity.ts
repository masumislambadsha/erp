import { uuidv7 } from '@erp/db';
import { NIL_USER } from '../context/request-context.js';
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

/**
 * Rebuilds stock balances, open-item remainders, journal sums and closed-period totals from the
 * ledgers and compares them with the stored values (PLAN.md rule 11). The result is recorded in
 * integrity_run either way, so a clean night is on file too. Runs as erp_app in the tenant's own
 * transaction; the supervisor (erp_scheduler) only decides which tenants to visit.
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
