import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { z } from 'zod';
import { and, eq, inArray, schema, uuidv7 } from '@erp/db';
import { DocTypeDef, docPermissions } from '@erp/meta';
import { Ctx } from '../auth/auth.guard.js';
import { Requires } from '../authz/permissions.js';
import type { AuthContext } from '../context/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { isPgError } from '../pg-errors.js';
import { ZodPipe } from '../zod.pipe.js';
import { describeDocType, loadDocType } from './doc-types.js';

const { docTypeDef, role, rolePermission } = schema;

const Create = z
  .object({
    docType: z
      .string()
      .regex(/^[a-z][a-z_]*$/)
      .max(40),
    definition: z.unknown(),
    /** Roles that receive the new type's permissions. */
    grantTo: z.array(z.string().min(1).max(60)).max(20).default(['admin']),
  })
  .strict();
const Update = z.object({ definition: z.unknown(), isActive: z.boolean().optional() }).strict();

function parseDefinition(input: unknown) {
  const r = DocTypeDef.safeParse(input);
  if (!r.success) {
    throw new BadRequestException({
      message: 'invalid definition',
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

@Controller('meta/doc-types')
export class MetaController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** The types you may use: you hold at least one of their permissions (or may manage metadata). */
  @Requires()
  @Get()
  list(@Ctx() auth: AuthContext) {
    return this.database.withTenant(auth, async (tx) => {
      const rows = await tx.db.select().from(docTypeDef).orderBy(docTypeDef.docType);
      const out = [];
      for (const r of rows) {
        if (
          !auth.permissions.has('meta:manage') &&
          !docPermissions(r.docType).some((p) => auth.permissions.has(p))
        )
          continue;
        out.push(describeDocType(await loadDocType(tx, r.docType)));
      }
      return out;
    });
  }

  @Requires()
  @Get(':code')
  get(@Ctx() auth: AuthContext, @Param('code') code: string) {
    return this.database.withTenant(auth, async (tx) => {
      const t = await loadDocType(tx, code);
      if (
        !auth.permissions.has('meta:manage') &&
        !docPermissions(code).some((p) => auth.permissions.has(p))
      )
        throw new NotFoundException();
      return describeDocType(t);
    });
  }

  @Requires('meta:manage')
  @Post()
  async create(@Ctx() auth: AuthContext, @Body(new ZodPipe(Create)) body: z.infer<typeof Create>) {
    const def = parseDefinition(body.definition);
    try {
      return await this.database.withTenant(auth, async (tx) => {
        const id = uuidv7();
        await tx.db
          .insert(docTypeDef)
          .values({ tenantId: auth.tenantId, id, docType: body.docType, definition: def });
        const roles = await tx.db.select().from(role).where(inArray(role.name, body.grantTo));
        if (roles.length !== new Set(body.grantTo).size)
          throw new BadRequestException('unknown role in grantTo');
        for (const r of roles) {
          for (const permission of docPermissions(body.docType)) {
            await tx.db
              .insert(rolePermission)
              .values({ tenantId: auth.tenantId, id: uuidv7(), roleId: r.id, permission })
              .onConflictDoNothing();
          }
        }
        return describeDocType(await loadDocType(tx, body.docType));
      });
    } catch (e) {
      if (isPgError(e, '23505'))
        throw new ConflictException('a document type with this code exists');
      throw e;
    }
  }

  @Requires('meta:manage')
  @Put(':code')
  update(
    @Ctx() auth: AuthContext,
    @Param('code') code: string,
    @Body(new ZodPipe(Update)) body: z.infer<typeof Update>,
  ) {
    const def = parseDefinition(body.definition);
    return this.database.withTenant(auth, async (tx) => {
      const cur = await loadDocType(tx, code);
      await tx.db
        .update(docTypeDef)
        .set({
          definition: def,
          version: cur.version + 1,
          ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
        })
        .where(and(eq(docTypeDef.id, cur.id), eq(docTypeDef.version, cur.version)));
      return describeDocType(await loadDocType(tx, code));
    });
  }
}
