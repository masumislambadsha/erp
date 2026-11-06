import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AllowPendingMfa, Requires } from '../authz/permissions.js';
import type { Config } from '../config.js';
import type { AuthContext } from '../context/request-context.js';
import { CONFIG } from '../tokens.js';
import { ZodPipe } from '../zod.pipe.js';
import { Ctx, Public } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { clearedCookie, sessionCookie } from './cookies.js';

const SignIn = z
  .object({
    tenantId: z.uuid(),
    email: z.string().min(3).max(254),
    password: z.string().min(1).max(200),
  })
  .strict();
const Code = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
const ChangePassword = z
  .object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200) })
  .strict();
const Id = z.uuid();

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Public()
  @Post('sign-in')
  @HttpCode(200)
  async signIn(
    @Body(new ZodPipe(SignIn)) body: z.infer<typeof SignIn>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.auth.signIn({ ...body, ip: req.ip, userAgent: req.headers['user-agent'] });
    res.setHeader('Set-Cookie', sessionCookie(r.cookie, r.maxAgeSeconds, this.config.cookieSecure));
    return { user: r.user, mfa: r.mfa };
  }

  @AllowPendingMfa()
  @Post('sign-out')
  @HttpCode(204)
  async signOut(@Ctx() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.signOut(auth);
    res.setHeader('Set-Cookie', clearedCookie(this.config.cookieSecure));
  }

  @AllowPendingMfa()
  @Get('me')
  me(@Ctx() auth: AuthContext) {
    return this.auth.me(auth);
  }

  @AllowPendingMfa()
  @Post('totp/enroll')
  @HttpCode(200)
  enroll(@Ctx() auth: AuthContext) {
    return this.auth.totpEnroll(auth);
  }

  @AllowPendingMfa()
  @Post('totp/verify')
  @HttpCode(204)
  async verify(@Ctx() auth: AuthContext, @Body(new ZodPipe(Code)) body: z.infer<typeof Code>) {
    await this.auth.totpVerify(auth, body.code);
  }

  @Requires()
  @Post('password')
  @HttpCode(204)
  async password(
    @Ctx() auth: AuthContext,
    @Body(new ZodPipe(ChangePassword)) body: z.infer<typeof ChangePassword>,
  ) {
    await this.auth.changePassword(auth, body.current, body.next);
  }

  @Requires()
  @Get('sessions')
  sessions(@Ctx() auth: AuthContext) {
    return this.auth.listSessions(auth);
  }

  @Requires()
  @Post('sessions/revoke-others')
  @HttpCode(200)
  revokeOthers(@Ctx() auth: AuthContext) {
    return this.auth.revokeOthers(auth);
  }

  @Requires()
  @Delete('sessions/:id')
  @HttpCode(204)
  async revoke(@Ctx() auth: AuthContext, @Param('id', new ZodPipe(Id)) id: string) {
    await this.auth.revokeSession(auth, id);
  }
}
