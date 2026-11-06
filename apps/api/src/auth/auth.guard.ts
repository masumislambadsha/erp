import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Config } from '../config.js';
import { PENDING_MFA_KEY, REQUIRES_KEY, type Permission } from '../authz/permissions.js';
import { resolveContext } from '../context/resolve-context.js';
import type { AuthContext, RequestWithContext } from '../context/request-context.js';
import { CONFIG } from '../tokens.js';
import { COOKIE_NAME, CSRF_HEADER, readCookie } from './cookies.js';
import { SessionService } from './session.service.js';

const PUBLIC = 'erp:public';
export const PUBLIC_KEY = PUBLIC;
/** Marks a route that needs no sign-in (health, sign-in). Everything else is deny by default. */
export const Public = () => SetMetadata(PUBLIC, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<RequestWithContext>();
    let auth: AuthContext | null = null;
    const stub = resolveContext(this.config, req.headers);
    if (stub) {
      auth = await this.sessions.authenticateStub(stub.tenantId, stub.userId);
    } else {
      const cookie = readCookie(req.headers.cookie, COOKIE_NAME);
      if (cookie) auth = await this.sessions.authenticate(cookie);
    }
    if (!auth) throw new UnauthorizedException();

    // A cookie is sent by the browser on any request, so state changes need a header that a
    // cross-site form cannot set.
    if (
      auth.via === 'session' &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.headers[CSRF_HEADER] !== '1'
    ) {
      throw new ForbiddenException(`missing ${CSRF_HEADER} header`);
    }

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      REQUIRES_KEY,
      targets,
    );
    const pendingOk =
      this.reflector.getAllAndOverride<boolean | undefined>(PENDING_MFA_KEY, targets) === true;
    if (required === undefined && !pendingOk) {
      throw new ForbiddenException('route declares no permission'); // deny by default
    }
    if (!auth.mfaPassed && !pendingOk) {
      throw new ForbiddenException({
        message: 'two-factor sign-in required',
        code: 'mfa_required',
      });
    }
    for (const p of required ?? []) {
      if (!auth.permissions.has(p)) throw new ForbiddenException(`missing permission ${p}`);
    }
    req.erpAuth = auth;
    return true;
  }
}

/** Injects the caller's tenant, user and access. */
export const Ctx = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const auth = context.switchToHttp().getRequest<RequestWithContext>().erpAuth;
    if (!auth) throw new UnauthorizedException();
    return auth;
  },
);
