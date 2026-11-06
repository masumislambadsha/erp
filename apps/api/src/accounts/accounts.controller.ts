import { Controller, Get, Inject } from '@nestjs/common';
import { inArray, schema } from '@erp/db';
import { Ctx } from '../auth/auth.guard.js';
import { Requires } from '../authz/permissions.js';
import { companyScope } from '../authz/rules.js';
import type { AuthContext } from '../context/request-context.js';
import { DatabaseService } from '../database/database.service.js';

const { account } = schema;

/** Read-only chart of accounts. Demonstrates a record rule: a role limited to some companies sees only theirs. */
@Controller('accounts')
export class AccountsController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Requires('account:read')
  @Get()
  list(@Ctx() auth: AuthContext) {
    const scope = companyScope(auth.rules, 'account'); // null: every company
    return this.database.withTenant(auth, (tx) =>
      scope === null
        ? tx.db.select().from(account).orderBy(account.code)
        : scope.length === 0
          ? Promise.resolve([])
          : tx.db
              .select()
              .from(account)
              .where(inArray(account.companyId, scope))
              .orderBy(account.code),
    );
  }
}
