import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { desc, eq, schema } from '@erp/db';
import { Ctx } from '../auth/auth.guard.js';
import { Requires } from '../authz/permissions.js';
import type { AuthContext } from '../context/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { ZodPipe } from '../zod.pipe.js';

const { auditLog } = schema;
const Query_ = z.object({
  entity: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

@Controller('audit')
export class AuditController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Requires('audit:read')
  @Get()
  list(@Ctx() auth: AuthContext, @Query(new ZodPipe(Query_)) q: z.infer<typeof Query_>) {
    return this.database.withTenant(auth, (tx) => {
      const base = tx.db.select().from(auditLog);
      return (q.entity ? base.where(eq(auditLog.entity, q.entity)) : base)
        .orderBy(desc(auditLog.id))
        .limit(q.limit);
    });
  }
}
