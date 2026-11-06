import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, isNull, ne, schema, type Tx } from '@erp/db';
import { loadAccess } from '../authz/load.js';
import type { Config } from '../config.js';
import { type AuthContext, NIL_USER } from '../context/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import {
  hashPassword,
  needsRehash,
  passwordProblem,
  verifyAgainstDummy,
  verifyPassword,
} from '../security/password.js';
import { newSession } from '../security/session-token.js';
import { open, seal } from '../security/secret-box.js';
import { generateSecret, base32Encode, otpauthUri, verifyTotp } from '../security/totp.js';
import { CONFIG } from '../tokens.js';
import { ABSOLUTE_MS } from './session.service.js';

const { appUser, userCredential, session, authEvent, tenant } = schema;

export const MAX_FAILED = 5;
export const LOCK_MS = 15 * 60_000;

export interface SignInResult {
  cookie: string;
  maxAgeSeconds: number;
  user: { id: string; email: string; name: string };
  mfa: { required: boolean; enrolled: boolean; verified: boolean };
}

type Outcome = { ok: true; result: SignInResult } | { ok: false };

@Injectable()
export class AuthService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async signIn(input: {
    tenantId: string;
    email: string;
    password: string;
    ip?: string;
    userAgent?: string;
  }): Promise<SignInResult> {
    const email = input.email.trim().toLowerCase();
    // The tenant here is the realm being signed in to. It is not trusted after this call: the
    // session cookie, issued by us, is what carries it from now on.
    const outcome = await this.database.withTenant(
      { tenantId: input.tenantId, userId: NIL_USER },
      async (tx): Promise<Outcome> => {
        const event = (kind: string, userId: string | null, detail: Record<string, unknown> = {}) =>
          tx.db
            .insert(authEvent)
            .values({ tenantId: input.tenantId, userId, kind, ip: input.ip ?? null, detail });
        const [known] = await tx.db.select({ id: tenant.id }).from(tenant);
        if (!known) {
          await verifyAgainstDummy(input.password); // no such tenant: nothing to record against
          return { ok: false };
        }
        const [user] = await tx.db.select().from(appUser).where(eq(appUser.email, email));
        const [cred] = user
          ? await tx.db.select().from(userCredential).where(eq(userCredential.userId, user.id))
          : [];
        if (!user || !cred || user.status !== 'active') {
          await verifyAgainstDummy(input.password); // same cost as a real check
          await event('sign_in_failed', user?.id ?? null, {
            reason: user ? 'disabled' : 'unknown',
          });
          return { ok: false };
        }
        const now = new Date();
        if (cred.lockedUntil && cred.lockedUntil > now) {
          await verifyAgainstDummy(input.password);
          await event('sign_in_locked', user.id);
          return { ok: false };
        }
        if (!(await verifyPassword(cred.passwordHash, input.password))) {
          const attempts = cred.failedAttempts + 1;
          const lock = attempts >= MAX_FAILED;
          await tx.db
            .update(userCredential)
            .set({
              failedAttempts: lock ? 0 : attempts,
              lockedUntil: lock ? new Date(now.getTime() + LOCK_MS) : cred.lockedUntil,
            })
            .where(eq(userCredential.userId, user.id));
          await event(lock ? 'account_locked' : 'sign_in_failed', user.id, { reason: 'password' });
          return { ok: false };
        }
        const update: Partial<typeof userCredential.$inferInsert> = {
          failedAttempts: 0,
          lockedUntil: null,
        };
        if (needsRehash(cred.passwordHash))
          update.passwordHash = await hashPassword(input.password);
        await tx.db.update(userCredential).set(update).where(eq(userCredential.userId, user.id));

        const s = newSession(input.tenantId);
        await tx.db.insert(session).values({
          tenantId: input.tenantId,
          id: s.id,
          userId: user.id,
          secretHash: s.secretHash,
          expiresAt: new Date(now.getTime() + ABSOLUTE_MS),
          ip: input.ip ?? null,
          userAgent: input.userAgent?.slice(0, 300) ?? null,
        });
        await event('sign_in', user.id, { sessionId: s.id });
        const access = (await loadAccess(tx, user.id))!;
        return {
          ok: true,
          result: {
            cookie: s.cookie,
            maxAgeSeconds: ABSOLUTE_MS / 1000,
            user: { id: user.id, email: user.email, name: user.name },
            mfa: {
              required: access.mfaRequired,
              enrolled: access.totpEnrolled,
              verified: !access.mfaRequired,
            },
          },
        };
      },
    );
    if (!outcome.ok) throw new UnauthorizedException('invalid credentials');
    return outcome.result;
  }

  me(auth: AuthContext) {
    return {
      user: { id: auth.userId, email: auth.email, name: auth.name },
      tenantId: auth.tenantId,
      roles: auth.roleNames,
      permissions: [...auth.permissions].sort(),
      mfa: { required: auth.mfaRequired, enrolled: auth.totpEnrolled, verified: auth.mfaPassed },
    };
  }

  async signOut(auth: AuthContext): Promise<void> {
    if (!auth.sessionId) return;
    await this.database.withTenant(auth, async (tx) => {
      await tx.db
        .update(session)
        .set({ revokedAt: new Date() })
        .where(and(eq(session.id, auth.sessionId!), isNull(session.revokedAt)));
      await tx.db
        .insert(authEvent)
        .values({
          tenantId: auth.tenantId,
          userId: auth.userId,
          kind: 'sign_out',
          detail: { sessionId: auth.sessionId },
        });
    });
  }

  listSessions(auth: AuthContext) {
    return this.database.withTenant(auth, async (tx) => {
      const rows = await tx.db
        .select()
        .from(session)
        .where(and(eq(session.userId, auth.userId), isNull(session.revokedAt)));
      return rows.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        ip: s.ip,
        userAgent: s.userAgent,
        current: s.id === auth.sessionId,
      }));
    });
  }

  /** Revoke one session. Your own always; someone else's needs session:revoke. */
  async revokeSession(auth: AuthContext, sessionId: string): Promise<void> {
    const n = await this.database.withTenant(auth, async (tx) => {
      const [s] = await tx.db.select().from(session).where(eq(session.id, sessionId));
      if (!s) return 0;
      if (s.userId !== auth.userId && !auth.permissions.has('session:revoke'))
        throw new ForbiddenException('missing permission session:revoke');
      const r = await tx.db
        .update(session)
        .set({ revokedAt: new Date() })
        .where(and(eq(session.id, sessionId), isNull(session.revokedAt)))
        .returning({ id: session.id });
      await tx.db
        .insert(authEvent)
        .values({
          tenantId: auth.tenantId,
          userId: s.userId,
          kind: 'session_revoked',
          detail: { sessionId, by: auth.userId },
        });
      return r.length;
    });
    if (n === 0) throw new NotFoundException();
  }

  async revokeOthers(auth: AuthContext): Promise<{ revoked: number }> {
    return this.database.withTenant(auth, async (tx) => ({
      revoked: await revokeUserSessions(tx, auth, auth.userId, auth.sessionId),
    }));
  }

  async changePassword(auth: AuthContext, current: string, next: string): Promise<void> {
    const problem = passwordProblem(next, auth.email);
    if (problem) throw new BadRequestException(`password ${problem}`);
    const hash = await hashPassword(next);
    const ok = await this.database.withTenant(auth, async (tx) => {
      const [cred] = await tx.db
        .select()
        .from(userCredential)
        .where(eq(userCredential.userId, auth.userId));
      if (!cred || !(await verifyPassword(cred.passwordHash, current))) return false;
      await tx.db
        .update(userCredential)
        .set({ passwordHash: hash, passwordChangedAt: new Date() })
        .where(eq(userCredential.userId, auth.userId));
      await tx.db
        .insert(authEvent)
        .values({ tenantId: auth.tenantId, userId: auth.userId, kind: 'password_changed' });
      await revokeUserSessions(tx, auth, auth.userId, auth.sessionId); // a stolen session must not survive a password change
      return true;
    });
    if (!ok) throw new UnauthorizedException('current password is wrong');
  }

  async totpEnroll(auth: AuthContext): Promise<{ secret: string; otpauthUri: string }> {
    requireSession(auth);
    const secret = generateSecret();
    const sealed = seal(this.config.totpKey, secret, `${auth.tenantId}:${auth.userId}`);
    const done = await this.database.withTenant(auth, async (tx) => {
      const [cred] = await tx.db
        .select()
        .from(userCredential)
        .where(eq(userCredential.userId, auth.userId));
      if (cred?.totpEnabledAt) return false;
      await tx.db
        .update(userCredential)
        .set({ totpSecret: sealed, totpLastStep: null })
        .where(eq(userCredential.userId, auth.userId));
      await tx.db
        .insert(authEvent)
        .values({ tenantId: auth.tenantId, userId: auth.userId, kind: 'totp_enrol_started' });
      return true;
    });
    if (!done) throw new ConflictException('two-factor is already set up');
    return { secret: base32Encode(secret), otpauthUri: otpauthUri('ERP', auth.email, secret) };
  }

  async totpVerify(auth: AuthContext, code: string): Promise<void> {
    requireSession(auth);
    const outcome = await this.database.withTenant(auth, async (tx) => {
      const [cred] = await tx.db
        .select()
        .from(userCredential)
        .where(eq(userCredential.userId, auth.userId));
      if (!cred?.totpSecret) return 'not_enrolled' as const;
      const secret = open(this.config.totpKey, cred.totpSecret, `${auth.tenantId}:${auth.userId}`);
      const step = verifyTotp(secret, code, Date.now(), cred.totpLastStep);
      const now = new Date();
      if (step === null) {
        const attempts = cred.failedAttempts + 1;
        const lock = attempts >= MAX_FAILED;
        await tx.db
          .update(userCredential)
          .set({
            failedAttempts: lock ? 0 : attempts,
            lockedUntil: lock ? new Date(now.getTime() + LOCK_MS) : cred.lockedUntil,
          })
          .where(eq(userCredential.userId, auth.userId));
        if (lock) await revokeUserSessions(tx, auth, auth.userId, null);
        await tx.db
          .insert(authEvent)
          .values({
            tenantId: auth.tenantId,
            userId: auth.userId,
            kind: lock ? 'account_locked' : 'totp_failed',
          });
        return 'wrong' as const;
      }
      await tx.db
        .update(userCredential)
        .set({ totpLastStep: step, totpEnabledAt: cred.totpEnabledAt ?? now, failedAttempts: 0 })
        .where(eq(userCredential.userId, auth.userId));
      await tx.db.update(session).set({ mfaAt: now }).where(eq(session.id, auth.sessionId!));
      await tx.db
        .insert(authEvent)
        .values({
          tenantId: auth.tenantId,
          userId: auth.userId,
          kind: cred.totpEnabledAt ? 'totp_verified' : 'totp_enrolled',
        });
      return 'ok' as const;
    });
    if (outcome === 'not_enrolled') throw new ConflictException('start two-factor set-up first');
    if (outcome === 'wrong') throw new UnauthorizedException('invalid code');
  }
}

function requireSession(auth: AuthContext): void {
  if (!auth.sessionId)
    throw new ForbiddenException('needs a real session, not the development stub');
}

/** Revokes a user's live sessions, except one. Returns how many. */
export async function revokeUserSessions(
  tx: Tx,
  by: AuthContext,
  userId: string,
  except: string | null,
): Promise<number> {
  const rows = await tx.db
    .update(session)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(session.userId, userId),
        isNull(session.revokedAt),
        except ? ne(session.id, except) : undefined,
      ),
    )
    .returning({ id: session.id });
  if (rows.length > 0) {
    await tx.db
      .insert(authEvent)
      .values({
        tenantId: by.tenantId,
        userId,
        kind: 'sessions_revoked',
        detail: { count: rows.length, by: by.userId },
      });
  }
  return rows.length;
}
