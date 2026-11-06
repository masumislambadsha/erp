import { Inject, Injectable } from '@nestjs/common';
import { eq, schema } from '@erp/db';
import { loadAccess } from '../authz/load.js';
import { type AuthContext, NIL_USER } from '../context/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { parseCookie, secretMatches } from '../security/session-token.js';

const { session } = schema;

export const IDLE_MS = 30 * 60_000; // signed out after 30 minutes without a request
export const ABSOLUTE_MS = 12 * 3_600_000; // and after 12 hours whatever happens
const TOUCH_MS = 60_000; // last_seen_at is written at most once a minute

@Injectable()
export class SessionService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Cookie value to the caller, or null. Every failure looks the same to the client. */
  async authenticate(cookie: string): Promise<AuthContext | null> {
    const token = parseCookie(cookie);
    if (!token) return null;
    // The tenant in the cookie only opens the transaction. The row must exist inside it and the
    // secret must match, so a forged tenant finds nothing.
    return this.database.withTenant({ tenantId: token.tenantId, userId: NIL_USER }, async (tx) => {
      const [s] = await tx.db.select().from(session).where(eq(session.id, token.sessionId));
      if (!s || !secretMatches(token.secret, s.secretHash)) return null;
      const now = Date.now();
      if (s.revokedAt || s.expiresAt.getTime() <= now || s.lastSeenAt.getTime() + IDLE_MS <= now)
        return null;
      const access = await loadAccess(tx, s.userId);
      if (!access || access.user.status !== 'active') return null;
      if (now - s.lastSeenAt.getTime() > TOUCH_MS) {
        await tx.db
          .update(session)
          .set({ lastSeenAt: new Date(now) })
          .where(eq(session.id, s.id));
      }
      return {
        tenantId: token.tenantId,
        userId: s.userId,
        via: 'session' as const,
        sessionId: s.id,
        email: access.user.email,
        name: access.user.name,
        roleNames: access.roleNames,
        permissions: access.permissions,
        rules: access.rules,
        mfaRequired: access.mfaRequired,
        mfaPassed: !access.mfaRequired || s.mfaAt !== null,
        totpEnrolled: access.totpEnrolled,
      };
    });
  }

  /** Development stub: the user must exist; what they may do still comes from their roles. */
  async authenticateStub(tenantId: string, userId: string): Promise<AuthContext | null> {
    return this.database.withTenant({ tenantId, userId }, async (tx) => {
      const access = await loadAccess(tx, userId);
      if (!access || access.user.status !== 'active') return null;
      return {
        tenantId,
        userId,
        via: 'stub' as const,
        sessionId: null,
        email: access.user.email,
        name: access.user.name,
        roleNames: access.roleNames,
        permissions: access.permissions,
        rules: access.rules,
        mfaRequired: false,
        mfaPassed: true,
        totpEnrolled: access.totpEnrolled,
      };
    });
  }
}
