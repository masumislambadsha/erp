import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { z } from 'zod';
import { eq, schema, uuidv7, type Tx } from '@erp/db';
import { Ctx } from '../auth/auth.guard.js';
import { PERMISSIONS, Requires } from '../authz/permissions.js';
import type { AuthContext } from '../context/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { isPgError } from '../pg-errors.js';
import { ZodPipe } from '../zod.pipe.js';

const { role, rolePermission, roleRecordRule, roleFieldRule, userRole } = schema;

const Definition = z
  .object({
    name: z.string().min(1).max(60),
    description: z.string().max(300).default(''),
    requiresTotp: z.boolean().default(false),
    permissions: z.array(z.enum(PERMISSIONS)).max(200),
    recordRules: z
      .array(z.object({ entity: z.string().min(1).max(60), companyId: z.uuid() }).strict())
      .max(200)
      .default([]),
    fieldRules: z
      .array(
        z
          .object({
            entity: z.string().min(1).max(60),
            field: z.string().min(1).max(60),
            access: z.enum(['hidden', 'read_only']),
          })
          .strict(),
      )
      .max(200)
      .default([]),
  })
  .strict();
type Def = z.infer<typeof Definition>;
const Id = z.uuid();

@Controller('roles')
export class RolesController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Requires('role:read')
  @Get()
  list(@Ctx() auth: AuthContext) {
    return this.database.withTenant(auth, async (tx) => {
      const roles = await tx.db.select().from(role).orderBy(role.name);
      return Promise.all(roles.map((r) => describe(tx, r)));
    });
  }

  @Requires('role:manage')
  @Post()
  async create(@Ctx() auth: AuthContext, @Body(new ZodPipe(Definition)) body: Def) {
    const id = uuidv7();
    try {
      return await this.database.withTenant(auth, async (tx) => {
        await tx.db
          .insert(role)
          .values({
            tenantId: auth.tenantId,
            id,
            name: body.name,
            description: body.description,
            requiresTotp: body.requiresTotp,
          });
        await writeRules(tx, auth.tenantId, id, body);
        return describe(tx, (await tx.db.select().from(role).where(eq(role.id, id)))[0]!);
      });
    } catch (e) {
      throw mapError(e);
    }
  }

  @Requires('role:manage')
  @Put(':id')
  async replace(
    @Ctx() auth: AuthContext,
    @Param('id', new ZodPipe(Id)) id: string,
    @Body(new ZodPipe(Definition)) body: Def,
  ) {
    try {
      return await this.database.withTenant(auth, async (tx) => {
        const [r] = await tx.db.select().from(role).where(eq(role.id, id));
        if (!r) throw new NotFoundException();
        await tx.db
          .update(role)
          .set({ name: body.name, description: body.description, requiresTotp: body.requiresTotp })
          .where(eq(role.id, id));
        await tx.db.delete(rolePermission).where(eq(rolePermission.roleId, id));
        await tx.db.delete(roleRecordRule).where(eq(roleRecordRule.roleId, id));
        await tx.db.delete(roleFieldRule).where(eq(roleFieldRule.roleId, id));
        await writeRules(tx, auth.tenantId, id, body);
        return describe(tx, (await tx.db.select().from(role).where(eq(role.id, id)))[0]!);
      });
    } catch (e) {
      throw mapError(e);
    }
  }

  @Requires('role:manage')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() auth: AuthContext, @Param('id', new ZodPipe(Id)) id: string) {
    await this.database.withTenant(auth, async (tx) => {
      const [r] = await tx.db.select().from(role).where(eq(role.id, id));
      if (!r) throw new NotFoundException();
      if (r.isSystem) throw new ConflictException('seeded roles cannot be deleted');
      if ((await tx.db.select().from(userRole).where(eq(userRole.roleId, id))).length)
        throw new ConflictException('role is assigned to users');
      await tx.db.delete(role).where(eq(role.id, id));
    });
  }
}

async function writeRules(tx: Tx, tenantId: string, roleId: string, d: Def) {
  for (const p of new Set(d.permissions))
    await tx.db.insert(rolePermission).values({ tenantId, id: uuidv7(), roleId, permission: p });
  for (const r of d.recordRules)
    await tx.db.insert(roleRecordRule).values({ tenantId, id: uuidv7(), roleId, ...r });
  for (const f of d.fieldRules)
    await tx.db.insert(roleFieldRule).values({ tenantId, id: uuidv7(), roleId, ...f });
}

async function describe(tx: Tx, r: typeof role.$inferSelect) {
  const perms = await tx.db.select().from(rolePermission).where(eq(rolePermission.roleId, r.id));
  const rec = await tx.db.select().from(roleRecordRule).where(eq(roleRecordRule.roleId, r.id));
  const fld = await tx.db.select().from(roleFieldRule).where(eq(roleFieldRule.roleId, r.id));
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    requiresTotp: r.requiresTotp,
    isSystem: r.isSystem,
    permissions: perms.map((p) => p.permission).sort(),
    recordRules: rec.map((x) => ({ entity: x.entity, companyId: x.companyId })),
    fieldRules: fld.map((x) => ({ entity: x.entity, field: x.field, access: x.access })),
  };
}

function mapError(e: unknown): unknown {
  if (isPgError(e, '23505')) return new ConflictException('a role with this name exists');
  if (isPgError(e, '23503')) return new BadRequestException('unknown company');
  return e;
}
