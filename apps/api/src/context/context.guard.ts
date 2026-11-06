import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CONFIG } from '../tokens.js';
import type { Config } from '../config.js';
import { resolveContext } from './resolve-context.js';
import type { RequestContext, RequestWithContext } from './request-context.js';

const PUBLIC = 'erp:public';
/** Marks a route that needs no tenant context (health checks). Everything else is deny by default. */
export const Public = () => SetMetadata(PUBLIC, true);

@Injectable()
export class ContextGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC, [context.getHandler(), context.getClass()])
    ) {
      return true;
    }
    const req = context.switchToHttp().getRequest<RequestWithContext>();
    const ctx = resolveContext(this.config, req.headers);
    if (!ctx) throw new UnauthorizedException();
    req.erpContext = ctx;
    return true;
  }
}

/** Injects the request's tenant and user. */
export const Ctx = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestContext => {
    const ctx = context.switchToHttp().getRequest<RequestWithContext>().erpContext;
    if (!ctx) throw new UnauthorizedException();
    return ctx;
  },
);
