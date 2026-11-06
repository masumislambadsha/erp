import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { PUBLIC_KEY } from '../src/auth/auth.guard.js';
import { AppModule } from '../src/app.module.js';
import { DOC_ACTIONS, docPermission, type DocAction } from '@erp/meta';
import {
  DOC_ACTION_KEY,
  PENDING_MFA_KEY,
  PERMISSIONS,
  type Permission,
  REQUIRES_KEY,
  SEED_ROLES,
} from '../src/authz/permissions.js';
import { addUser, call, makeRole, newTenant, startApp, stubHeaders, superuser } from './support.js';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];

interface Found {
  route: string;
  public: boolean;
  pending: boolean;
  requires: Permission[] | undefined;
  docAction: DocAction | undefined;
}

/** Every route the API registers, with the access declaration on it. */
function discover(): Found[] {
  const cfg = {
    nodeEnv: 'test',
    port: 0,
    databaseUrl: '',
    devAuthStub: false,
    totpKey: Buffer.alloc(32),
    cookieSecure: false,
  } as const;
  const controllers = (AppModule.forRoot(cfg).controllers ?? []) as (new () => object)[];
  const out: Found[] = [];
  for (const c of controllers) {
    const prefix = Reflect.getMetadata('path', c) as string;
    for (const name of Object.getOwnPropertyNames(c.prototype)) {
      const h = (c.prototype as Record<string, unknown>)[name];
      if (typeof h !== 'function' || name === 'constructor') continue;
      const m = Reflect.getMetadata('method', h) as number | undefined;
      if (m === undefined) continue;
      const sub = Reflect.getMetadata('path', h) as string;
      out.push({
        route: `${METHODS[m]} /${prefix}${sub && sub !== '/' ? '/' + sub : ''}`,
        public:
          Reflect.getMetadata(PUBLIC_KEY, h) === true ||
          Reflect.getMetadata(PUBLIC_KEY, c) === true,
        pending: Reflect.getMetadata(PENDING_MFA_KEY, h) === true,
        requires: Reflect.getMetadata(REQUIRES_KEY, h) as Permission[] | undefined,
        docAction: Reflect.getMetadata(DOC_ACTION_KEY, h) as DocAction | undefined,
      });
    }
  }
  return out;
}

/** Routes that need specific permissions, with a body that passes the guard but fails validation or finds nothing. */
const GUARDED: [route: string, permission: Permission, body?: unknown][] = [
  ['GET /parties', 'party:read'],
  ['GET /parties/:id', 'party:read'],
  ['POST /parties', 'party:write', {}],
  ['PATCH /parties/:id', 'party:write', { name: 'x' }],
  ['DELETE /parties/:id', 'party:write'],
  ['GET /accounts', 'account:read'],
  ['GET /users', 'user:read'],
  ['POST /users', 'user:manage', {}],
  ['PATCH /users/:id', 'user:manage', {}],
  ['PUT /users/:id/roles', 'role:manage', { roleIds: [] }],
  ['DELETE /users/:id/sessions', 'session:revoke'],
  ['GET /roles', 'role:read'],
  ['POST /roles', 'role:manage', {}],
  ['PUT /roles/:id', 'role:manage', {}],
  ['DELETE /roles/:id', 'role:manage'],
  ['GET /audit', 'audit:read'],
  ['POST /meta/doc-types', 'meta:manage', {}],
  ['PUT /meta/doc-types/:code', 'meta:manage', {}],
];
/** Routes whose permission is `<docType>:<action>`, built from the path. */
const DOCUMENT_ROUTES: [route: string, action: DocAction, body?: unknown][] = [
  ['GET /documents/:docType', 'read'],
  ['GET /documents/:docType/:id', 'read'],
  ['POST /documents/:docType', 'create', {}],
  ['PATCH /documents/:docType/:id', 'update', {}],
  ['DELETE /documents/:docType/:id', 'update'],
  ['POST /documents/:docType/:id/submit', 'submit'],
  ['POST /documents/:docType/:id/cancel', 'cancel'],
  ['POST /documents/:docType/:id/amend', 'amend'],
];
/** Any signed-in user, with TOTP done where required. */
const AUTHENTICATED = [
  'GET /meta/doc-types',
  'GET /meta/doc-types/:code',
  'POST /auth/password',
  'GET /auth/sessions',
  'POST /auth/sessions/revoke-others',
  'DELETE /auth/sessions/:id',
];
/** Allowed to a signed-in user who has not finished TOTP. */
const PENDING = [
  'POST /auth/sign-out',
  'GET /auth/me',
  'POST /auth/totp/enroll',
  'POST /auth/totp/verify',
];
const PUBLIC_ROUTES = ['GET /health', 'POST /auth/sign-in'];

describe('deny by default', () => {
  const found = discover();

  it('every route declares its access: public, pending-TOTP, authenticated or specific permissions', () => {
    const undeclared = found
      .filter(
        (f) => !f.public && !f.pending && f.requires === undefined && f.docAction === undefined,
      )
      .map((f) => f.route);
    expect(undeclared).toEqual([]);
  });

  it('the tables below list every route, so a new route cannot slip in untested', () => {
    const listed = [
      ...GUARDED.map((g) => g[0]),
      ...DOCUMENT_ROUTES.map((d) => d[0]),
      ...AUTHENTICATED,
      ...PENDING,
      ...PUBLIC_ROUTES,
    ].sort();
    expect(found.map((f) => f.route).sort()).toEqual(listed);
    for (const [route, permission] of GUARDED)
      expect(found.find((f) => f.route === route)!.requires).toEqual([permission]);
    for (const [route, action] of DOCUMENT_ROUTES)
      expect(found.find((f) => f.route === route)!.docAction).toBe(action);
    for (const route of AUTHENTICATED)
      expect(found.find((f) => f.route === route)!.requires).toEqual([]);
    for (const route of PENDING) expect(found.find((f) => f.route === route)!.pending).toBe(true);
    for (const route of PUBLIC_ROUTES)
      expect(found.find((f) => f.route === route)!.public).toBe(true);
  });

  it('every permission in the catalog guards at least one route', () => {
    const used = new Set(GUARDED.map((g) => g[1]));
    expect(PERMISSIONS.filter((p) => !used.has(p))).toEqual([]);
  });

  it('every document action guards at least one route', () => {
    const used = new Set(DOCUMENT_ROUTES.map((d) => d[1]));
    expect(DOC_ACTIONS.filter((a) => !used.has(a))).toEqual([]);
  });
});

describe('permissions per role', () => {
  let app: INestApplication;
  let base: string;
  let su: pg.Client;
  let tenantId: string;
  const users = new Map<string, string>();

  beforeAll(async () => {
    ({ app, base } = await startApp());
    su = await superuser();
    tenantId = (await newTenant('Permissions')).tenantId;
    for (const r of SEED_ROLES) users.set(r.name, (await addUser(su, tenantId, [r.name])).id);
    users.set('(no role)', (await addUser(su, tenantId, [])).id);
  });
  afterAll(async () => {
    await app?.close();
    await su?.end();
  });

  const roleNames = [...SEED_ROLES.map((r) => r.name), '(no role)'];
  const path = (route: string) =>
    route
      .split(' ')[1]!
      .replace(':id', uuidv7())
      .replace(':docType', 'ticket')
      .replace(':code', 'ticket');
  const send = (who: string, route: string, body?: unknown) =>
    call(base, route.split(' ')[0]!, path(route), stubHeaders(tenantId, users.get(who)!), body);

  describe.each(roleNames)('role %s', (who) => {
    const held = new Set<string>(SEED_ROLES.find((r) => r.name === who)?.permissions ?? []);

    it.each(GUARDED)('%s needs %s', async (route, permission, body) => {
      const { status } = await send(who, route, body);
      if (held.has(permission))
        expect([401, 403], `${who} should pass ${route}`).not.toContain(status);
      else expect(status, `${who} must be refused ${route}`).toBe(403);
    });

    it.each(AUTHENTICATED)('%s works for any signed-in user', async (route) => {
      const { status } = await send(who, route, route.includes('password') ? {} : undefined);
      expect([401, 403]).not.toContain(status);
    });
  });

  it.each([
    ...GUARDED.map((g) => g[0]),
    ...DOCUMENT_ROUTES.map((d) => d[0]),
    ...AUTHENTICATED,
    'GET /auth/me',
    'POST /auth/sign-out',
  ])('%s refuses a caller who is not signed in', async (route) => {
    const r = await call(
      base,
      route.split(' ')[0]!,
      path(route),
      { 'content-type': 'application/json' },
      route.startsWith('GET') || route.startsWith('DELETE') ? undefined : {},
    );
    expect(r.status).toBe(401);
  });

  it('the public routes need no sign-in', async () => {
    expect((await call(base, 'GET', '/health', {})).status).toBe(200);
    expect(
      (await call(base, 'POST', '/auth/sign-in', { 'content-type': 'application/json' }, {}))
        .status,
    ).toBe(400); // validation, not 401
  });
});

describe('document permissions, one at a time', () => {
  let app: INestApplication;
  let base: string;
  let su: pg.Client;
  let tenantId: string;
  const holders = new Map<string, string>(); // action -> a user holding only that permission
  const missing = new Map<string, string>(); // action -> a user holding every other permission

  beforeAll(async () => {
    ({ app, base } = await startApp());
    su = await superuser();
    const t = await newTenant('Doc permissions');
    tenantId = t.tenantId;
    const def = { label: { en: 'T', bn: 'T' }, numbering: { prefix: 'T-' }, fields: [] };
    await call(base, 'POST', '/meta/doc-types', stubHeaders(tenantId, t.adminId), {
      docType: 'ticket',
      definition: def,
      grantTo: [],
    });
    for (const a of DOC_ACTIONS) {
      await makeRole(su, tenantId, `only_${a}`, [docPermission('ticket', a)]);
      await makeRole(
        su,
        tenantId,
        `not_${a}`,
        DOC_ACTIONS.filter((x) => x !== a).map((x) => docPermission('ticket', x)),
      );
      holders.set(a, (await addUser(su, tenantId, [`only_${a}`])).id);
      missing.set(a, (await addUser(su, tenantId, [`not_${a}`])).id);
    }
  });
  afterAll(async () => {
    await app?.close();
    await su?.end();
  });

  it.each(DOCUMENT_ROUTES)(
    '%s needs exactly the %s permission of its own document type',
    async (route, action, body) => {
      const p = route.split(' ')[1]!.replace(':id', uuidv7()).replace(':docType', 'ticket');
      const send = (user: string) =>
        call(
          base,
          route.split(' ')[0]!,
          p,
          { ...stubHeaders(tenantId, user), 'idempotency-key': `k-${uuidv7()}` },
          body,
        );
      expect([401, 403], `holding only ${action}`).not.toContain(
        (await send(holders.get(action)!)).status,
      );
      expect((await send(missing.get(action)!)).status, `holding everything but ${action}`).toBe(
        403,
      );
    },
  );

  it('a permission of one document type opens nothing in another', async () => {
    const r = await call(
      base,
      'GET',
      '/documents/other_type',
      stubHeaders(tenantId, holders.get('read')!),
    );
    expect(r.status).toBe(403);
  });
});
