import {
  BadRequestException,
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { from, type Observable } from 'rxjs';
import { and, eq, schema } from '@erp/db';
import type { RequestWithContext } from '../context/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { IDEMPOTENT_KEY } from './idempotency.js';

const { idempotencyKey } = schema;

/**
 * Every write that creates or moves a document carries an Idempotency-Key. The first request with
 * a key runs and its answer is stored; a retry with the same key and the same request gets that
 * answer again instead of a second effect. The key row is claimed before the work and completed
 * after it, in separate transactions, so a crash between the two leaves an "in progress" claim: the
 * client sees 409 and the database's own guards (one submit per draft) still prevent a double post.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (
      !this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return next.handle();
    return from(this.handle(context, next));
  }

  private async handle(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const req = context
      .switchToHttp()
      .getRequest<RequestWithContext & { body?: unknown; originalUrl: string }>();
    const auth = req.erpAuth!;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
      throw new BadRequestException('an Idempotency-Key header of 8 to 100 characters is required');
    }
    const hash = createHash('sha256')
      .update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? null)}`)
      .digest('hex');

    const claimed = await this.database.withTenant(auth, async (tx) => {
      const ins = await tx.db
        .insert(idempotencyKey)
        .values({ tenantId: auth.tenantId, userId: auth.userId, key, requestHash: hash })
        .onConflictDoNothing()
        .returning({ key: idempotencyKey.key });
      if (ins.length > 0) return null;
      const [row] = await tx.db
        .select()
        .from(idempotencyKey)
        .where(and(eq(idempotencyKey.userId, auth.userId), eq(idempotencyKey.key, key)));
      return row!;
    });
    if (claimed) {
      if (claimed.requestHash !== hash)
        throw new UnprocessableEntityException(
          'this Idempotency-Key was used for a different request',
        );
      if (claimed.status !== 'done')
        throw new ConflictException('a request with this Idempotency-Key is still in progress');
      return claimed.responseBody;
    }

    try {
      const body = await new Promise((resolve, reject) =>
        next.handle().subscribe({ next: resolve, error: reject }),
      );
      await this.database.withTenant(auth, (tx) =>
        tx.db
          .update(idempotencyKey)
          .set({ status: 'done', responseStatus: 200, responseBody: (body ?? null) as never })
          .where(and(eq(idempotencyKey.userId, auth.userId), eq(idempotencyKey.key, key))),
      );
      return body;
    } catch (err) {
      // A refused request did nothing: free the key so the client can fix it and retry.
      await this.database
        .withTenant(auth, (tx) =>
          tx.db
            .delete(idempotencyKey)
            .where(and(eq(idempotencyKey.userId, auth.userId), eq(idempotencyKey.key, key))),
        )
        .catch(() => {});
      throw err;
    }
  }
}
