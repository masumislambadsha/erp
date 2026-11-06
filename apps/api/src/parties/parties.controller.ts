import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { eq, schema, uuidv7 } from '@erp/db';
import { Ctx } from '../auth/auth.guard.js';
import { Requires } from '../authz/permissions.js';
import { forbiddenFields, redact } from '../authz/rules.js';
import type { AuthContext } from '../context/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { ZodPipe } from '../zod.pipe.js';

const { party } = schema;

// .strict(): a body that names tenant_id (or any unknown key) is rejected, never ignored.
const CreateParty = z
  .object({
    name: z.string().min(1).max(200),
    bin: z.string().max(50).optional(),
    tin: z.string().max(50).optional(),
    address: z.string().max(500).optional(),
  })
  .strict();
const UpdateParty = CreateParty.partial().strict();
const PartyId = z.uuid();

/**
 * A thin slice of the API layer: master data CRUD through withTenant. It never filters by
 * tenant in SQL on purpose; isolation is the database's job (forced RLS), and the tests prove it.
 */
@Controller('parties')
export class PartiesController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Requires('party:read')
  @Get()
  async list(@Ctx() ctx: AuthContext) {
    const rows = await this.database.withTenant(ctx, (tx) =>
      tx.db.select().from(party).orderBy(party.name),
    );
    return rows.map((r) => redact(ctx.rules, 'party', r));
  }

  @Requires('party:read')
  @Get(':id')
  async get(@Ctx() ctx: AuthContext, @Param('id', new ZodPipe(PartyId)) id: string) {
    const rows = await this.database.withTenant(ctx, (tx) =>
      tx.db.select().from(party).where(eq(party.id, id)),
    );
    return rows[0] ? redact(ctx.rules, 'party', rows[0]) : notFound();
  }

  @Requires('party:write')
  @Post()
  async create(
    @Ctx() ctx: AuthContext,
    @Body(new ZodPipe(CreateParty)) body: z.infer<typeof CreateParty>,
  ) {
    denyFields(ctx, Object.keys(body));
    const rows = await this.database.withTenant(ctx, (tx) =>
      tx.db
        .insert(party)
        .values({ tenantId: ctx.tenantId, id: uuidv7(), ...body })
        .returning(),
    );
    return redact(ctx.rules, 'party', rows[0]!);
  }

  @Requires('party:write')
  @Patch(':id')
  async update(
    @Ctx() ctx: AuthContext,
    @Param('id', new ZodPipe(PartyId)) id: string,
    @Body(new ZodPipe(UpdateParty)) body: z.infer<typeof UpdateParty>,
  ) {
    denyFields(ctx, Object.keys(body));
    if (Object.keys(body).length === 0) return this.get(ctx, id);
    const rows = await this.database.withTenant(ctx, (tx) =>
      tx.db.update(party).set(body).where(eq(party.id, id)).returning(),
    );
    return rows[0] ? redact(ctx.rules, 'party', rows[0]) : notFound();
  }

  @Requires('party:write')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: AuthContext, @Param('id', new ZodPipe(PartyId)) id: string) {
    const rows = await this.database.withTenant(ctx, (tx) =>
      tx.db.delete(party).where(eq(party.id, id)).returning({ id: party.id }),
    );
    if (rows.length === 0) notFound();
  }
}

/** A field rule that hides or locks a field blocks writes to it as well as reads. */
function denyFields(ctx: AuthContext, fields: string[]): void {
  const bad = forbiddenFields(ctx.rules, 'party', fields);
  if (bad.length) throw new ForbiddenException(`you may not change: ${bad.join(', ')}`);
}

function notFound(): never {
  throw new NotFoundException();
}
