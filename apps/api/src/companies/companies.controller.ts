import { Controller, Get, Inject } from '@nestjs/common';
import { schema } from '@erp/db';
import { Ctx } from '../auth/auth.guard.js';
import { Requires } from '../authz/permissions.js';
import type { AuthContext } from '../context/request-context.js';
import { DatabaseService } from '../database/database.service.js';

const { company } = schema;

/** The companies of the tenant, for pickers on forms. Any signed-in user may list them. */
@Controller('companies')
export class CompaniesController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Requires()
  @Get()
  list(@Ctx() auth: AuthContext) {
    return this.database.withTenant(auth, (tx) =>
      tx.db
        .select({ id: company.id, name: company.name, baseCurrency: company.baseCurrency })
        .from(company)
        .orderBy(company.name),
    );
  }
}
