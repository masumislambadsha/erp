import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { Money } from '@erp/db';
import { isRealDate } from '@erp/meta';
import { Ctx } from '../auth/auth.guard.js';
import { Requires } from '../authz/permissions.js';
import type { AuthContext } from '../context/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { ZodPipe } from '../zod.pipe.js';

const Q = z
  .object({ companyId: z.uuid(), asOf: z.string().refine(isRealDate, 'a real date as YYYY-MM-DD') })
  .strict();

interface Row {
  account_id: string;
  code: string;
  name: string;
  kind: string;
  debit: string;
  credit: string;
}

@Controller('reports')
export class ReportsController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * The trial balance of a company as of a date, straight from the GL: every account's debit or credit
   * balance, and the totals, which must be equal. Amounts are decimal strings; the totals are summed with Money.
   */
  @Requires('report:read')
  @Get('trial-balance')
  async trialBalance(@Ctx() auth: AuthContext, @Query(new ZodPipe(Q)) q: z.infer<typeof Q>) {
    const rows = await this.database.withTenant(auth, (tx) =>
      tx.query<Row & Record<string, unknown>>(
        'SELECT account_id, code, name, kind, debit::text, credit::text FROM trial_balance($1, $2)',
        [q.companyId, q.asOf],
      ),
    );
    const debit = Money.sum(rows.map((r) => Money.of(r.debit)));
    const credit = Money.sum(rows.map((r) => Money.of(r.credit)));
    return {
      companyId: q.companyId,
      asOf: q.asOf,
      rows: rows.map((r) => ({
        accountId: r.account_id,
        code: r.code,
        name: r.name,
        kind: r.kind,
        debit: r.debit,
        credit: r.credit,
      })),
      totals: {
        debit: debit.toDbString(),
        credit: credit.toDbString(),
        balanced: debit.eq(credit),
      },
    };
  }
}
