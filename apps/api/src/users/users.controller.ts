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
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { z } from 'zod';
import { and, eq, inArray, schema, uuidv7 } from '@erp/db';
import { revokeUserSessions } from '../auth/auth.service.js';
import { Ctx } from '../auth/auth.guard.js';
import { Requires } from '../authz/permissions.js';
import type { AuthContext } from '../context/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { hashPassword, passwordProblem } from '../security/password.js';
import { isPgError } from '../pg-errors.js';
import { ZodPipe } from '../zod.pipe.js';

const { appUser, userCredential, userRole, role } = schema;

const CreateUser = z
  .object({
    email: z
      .string()
      .min(3)
      .max(254)
      .transform((e) => e.trim().toLowerCase()),
    name: z.string().min(1).max(200),
    password: z.string().min(1).max(200),
  })
  .strict();
const UpdateUser = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict();
const SetRoles = z.object({ roleIds: z.array(z.uuid()).max(50) }).strict();
const Id = z.uuid();

@Controller('users')
export class UsersController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Requires('user:read')
  @Get()
  list(@Ctx() auth: AuthContext) {
    return this.database.withTenant(auth, async (tx) => {
      const users = await tx.db.select().from(appUser).orderBy(appUser.email);
      const links = await tx.db
        .select({ userId: userRole.userId, name: role.name })
        .from(userRole)
        .innerJoin(role, and(eq(role.tenantId, userRole.tenantId), eq(role.id, userRole.roleId)));
      return users.map((u) => ({
        ...u,
        tenantId: undefined,
        roles: links
          .filter((l) => l.userId === u.id)
          .map((l) => l.name)
          .sort(),
      }));
    });
  }

  @Requires('user:manage')
  @Post()
  async create(
    @Ctx() auth: AuthContext,
    @Body(new ZodPipe(CreateUser)) body: z.infer<typeof CreateUser>,
  ) {
    const problem = passwordProblem(body.password, body.email);
    if (problem) throw new BadRequestException(`password ${problem}`);
    const hash = await hashPassword(body.password);
    const id = uuidv7();
    try {
      await this.database.withTenant(auth, async (tx) => {
        await tx.db
          .insert(appUser)
          .values({ tenantId: auth.tenantId, id, email: body.email, name: body.name });
        await tx.db
          .insert(userCredential)
          .values({ tenantId: auth.tenantId, userId: id, passwordHash: hash });
      });
    } catch (e) {
      if (isPgError(e, '23505')) throw new ConflictException('a user with this email exists');
      throw e;
    }
    return { id, email: body.email, name: body.name, status: 'active' };
  }

  @Requires('user:manage')
  @Patch(':id')
  async update(
    @Ctx() auth: AuthContext,
    @Param('id', new ZodPipe(Id)) id: string,
    @Body(new ZodPipe(UpdateUser)) body: z.infer<typeof UpdateUser>,
  ) {
    if (id === auth.userId && body.status === 'disabled')
      throw new BadRequestException('you cannot disable yourself');
    const rows = await this.database.withTenant(auth, async (tx) => {
      const r = Object.keys(body).length
        ? await tx.db.update(appUser).set(body).where(eq(appUser.id, id)).returning()
        : await tx.db.select().from(appUser).where(eq(appUser.id, id));
      if (body.status === 'disabled' && r.length) await revokeUserSessions(tx, auth, id, null); // sessions die with the account
      return r;
    });
    const u = rows[0];
    if (!u) throw new NotFoundException();
    return { id: u.id, email: u.email, name: u.name, status: u.status };
  }

  @Requires('role:manage')
  @Put(':id/roles')
  @HttpCode(204)
  async setRoles(
    @Ctx() auth: AuthContext,
    @Param('id', new ZodPipe(Id)) id: string,
    @Body(new ZodPipe(SetRoles)) body: z.infer<typeof SetRoles>,
  ) {
    if (id === auth.userId) throw new BadRequestException('you cannot change your own roles');
    const want = [...new Set(body.roleIds)];
    try {
      await this.database.withTenant(auth, async (tx) => {
        const [u] = await tx.db.select({ id: appUser.id }).from(appUser).where(eq(appUser.id, id));
        if (!u) throw new NotFoundException();
        const have = await tx.db.select().from(userRole).where(eq(userRole.userId, id));
        const drop = have.filter((h) => !want.includes(h.roleId)).map((h) => h.id);
        if (drop.length) await tx.db.delete(userRole).where(inArray(userRole.id, drop));
        for (const roleId of want.filter((w) => !have.some((h) => h.roleId === w))) {
          await tx.db
            .insert(userRole)
            .values({ tenantId: auth.tenantId, id: uuidv7(), userId: id, roleId });
        }
      });
    } catch (e) {
      if (isPgError(e, '23503')) throw new BadRequestException('unknown role');
      throw e;
    }
  }

  @Requires('session:revoke')
  @Delete(':id/sessions')
  @HttpCode(200)
  revokeSessions(@Ctx() auth: AuthContext, @Param('id', new ZodPipe(Id)) id: string) {
    return this.database.withTenant(auth, async (tx) => ({
      revoked: await revokeUserSessions(tx, auth, id, null),
    }));
  }
}
