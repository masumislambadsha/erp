import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerOptions } from '@nestjs/throttler';
import type { Config } from './config.js';
import type { RequestWithContext } from './context/request-context.js';

/**
 * Two limits (PLAN.md, Security: "Abuse"):
 *  - `user`: requests per minute per signed-in user, whatever the route;
 *  - `signin`: attempts per minute per client IP on POST /auth/sign-in, on top of the per-account lockout.
 * Counts live in memory, so each API instance counts for itself: fine for the single small server we
 * are heading for, and the thing to move to a shared store when there is more than one.
 */
export function throttlers(config: Config): ThrottlerOptions[] {
  const req = (ctx: { switchToHttp(): { getRequest<T>(): T } }) =>
    ctx
      .switchToHttp()
      .getRequest<
        RequestWithContext & { ip?: string; route?: { path?: string }; originalUrl?: string }
      >();
  const isSignIn = (ctx: Parameters<typeof req>[0]) =>
    req(ctx).method === 'POST' && (req(ctx).originalUrl ?? '').split('?')[0] === '/auth/sign-in';
  return [
    {
      name: 'user',
      ttl: 60_000,
      limit: config.rateLimit.userPerMinute,
      skipIf: (ctx) => !req(ctx).erpAuth, // anonymous traffic is limited per IP below, on sign-in
      getTracker: (r) => (r as RequestWithContext).erpAuth?.userId ?? '',
    },
    {
      name: 'signin',
      ttl: 60_000,
      limit: config.rateLimit.signInPerMinute,
      skipIf: (ctx) => !isSignIn(ctx),
      getTracker: (r) => (r as { ip?: string }).ip ?? 'unknown',
    },
  ];
}

@Injectable()
export class RateLimitGuard extends ThrottlerGuard {}
