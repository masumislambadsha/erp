import 'reflect-metadata';
import type { INestApplication, Type } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { z } from 'zod';
import { DOC_ACTION_KEY, PENDING_MFA_KEY, REQUIRES_KEY } from './authz/permissions.js';
import { PUBLIC_KEY } from './auth/auth.guard.js';
import { IDEMPOTENT_KEY } from './idempotency/idempotency.js';
import { ZodPipe } from './zod.pipe.js';

const ROUTE_ARGS = '__routeArguments__'; // @nestjs/common's metadata key for parameter decorators
const BODY = 3;
const QUERY = 4;
const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
};

type Schema = Record<string, unknown>;
const jsonSchema = (s: z.ZodType): Schema => {
  const out = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Schema;
  delete out.$schema;
  return out;
};

/**
 * The OpenAPI document. Nest's own scan finds every route; this adds what its decorators do not know,
 * read from the same metadata the guards use, so the spec cannot drift from the code:
 *  - request bodies and query strings, from the Zod schemas that validate them;
 *  - the permission each route needs (`x-permission`), and whether it is public or allowed before TOTP;
 *  - the Idempotency-Key header on the routes that require it;
 *  - cookie authentication and the CSRF header on writes.
 */
export function buildOpenApi(app: INestApplication, controllers: Type[]): OpenAPIObject {
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('ERP API')
      .setDescription(
        'Ledger-first ERP for trading companies. Sessions are httpOnly cookies; writes need x-erp-csrf: 1; document writes need an Idempotency-Key.',
      )
      .setVersion('0.0.0')
      .addCookieAuth(
        'erp_session',
        { type: 'apiKey', in: 'cookie', name: 'erp_session' },
        'session',
      )
      .build(),
  );
  for (const c of controllers) {
    const prefix = String(Reflect.getMetadata('path', c) ?? '');
    for (const name of Object.getOwnPropertyNames(c.prototype)) {
      const h = (c.prototype as Record<string, unknown>)[name];
      if (typeof h !== 'function' || name === 'constructor') continue;
      const m = Reflect.getMetadata('method', h) as number | undefined;
      if (m === undefined || !METHODS[m]) continue;
      const sub = String(Reflect.getMetadata('path', h) ?? '');
      const path = `/${[prefix, sub === '/' ? '' : sub].filter(Boolean).join('/')}`.replace(
        /:([A-Za-z]+)/g,
        '{$1}',
      );
      const op = (doc.paths[path] as Record<string, Record<string, unknown>> | undefined)?.[
        METHODS[m]!
      ];
      if (!op) continue;
      const args = (Reflect.getMetadata(ROUTE_ARGS, c, name) ?? {}) as Record<
        string,
        { pipes?: unknown[] }
      >;
      for (const [key, arg] of Object.entries(args)) {
        const type = Number(key.split(':')[0]);
        const pipe = arg.pipes?.find((p): p is ZodPipe<z.ZodType> => p instanceof ZodPipe);
        if (!pipe) continue;
        if (type === BODY)
          op.requestBody = {
            required: true,
            content: { 'application/json': { schema: jsonSchema(pipe.schema) } },
          };
        if (type === QUERY) {
          const schema = jsonSchema(pipe.schema) as {
            properties?: Record<string, Schema>;
            required?: string[];
          };
          op.parameters = [
            ...((op.parameters as unknown[]) ?? []),
            ...Object.entries(schema.properties ?? {}).map(([n, s]) => ({
              name: n,
              in: 'query',
              required: schema.required?.includes(n) ?? false,
              schema: s,
            })),
          ];
        }
      }
      const isPublic = Reflect.getMetadata(PUBLIC_KEY, h) === true;
      const requires = Reflect.getMetadata(REQUIRES_KEY, h) as string[] | undefined;
      const docAction = Reflect.getMetadata(DOC_ACTION_KEY, h) as string | undefined;
      op['x-access'] = isPublic
        ? 'public'
        : docAction
          ? `permission <docType>:${docAction}`
          : Reflect.getMetadata(PENDING_MFA_KEY, h)
            ? 'signed in (before TOTP allowed)'
            : requires?.length
              ? `permission ${requires.join(', ')}`
              : 'signed in';
      if (!isPublic) op.security = [{ session: [] }];
      if (Reflect.getMetadata(IDEMPOTENT_KEY, h) === true) {
        op.parameters = [
          ...((op.parameters as unknown[]) ?? []),
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            description:
              '8 to 100 characters; a retry with the same key and body replays the first answer',
            schema: { type: 'string', minLength: 8, maxLength: 100 },
          },
        ];
      }
      if (!isPublic && m !== RequestMethod.GET) {
        op.parameters = [
          ...((op.parameters as unknown[]) ?? []),
          {
            name: 'x-erp-csrf',
            in: 'header',
            required: true,
            description: 'Must be 1 for cookie sessions',
            schema: { type: 'string', enum: ['1'] },
          },
        ];
      }
    }
  }
  return doc;
}
