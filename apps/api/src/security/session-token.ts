import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { UUID_RE, uuidv7 } from '@erp/db';

/**
 * The session cookie is `<tenantId>.<sessionId>.<secret>`. The tenant part only says which
 * tenant's transaction to open; the session row is then found by id inside that tenant and the
 * secret must match its hash. A forged tenant part finds no row, so the tenant never rests on
 * anything the client can choose.
 */
export interface NewSession {
  id: string;
  cookie: string;
  secretHash: Buffer;
}

export function newSession(tenantId: string): NewSession {
  const id = uuidv7();
  const secret = randomBytes(32).toString('base64url');
  return { id, cookie: `${tenantId}.${id}.${secret}`, secretHash: hashSecret(secret) };
}

export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export interface ParsedToken {
  tenantId: string;
  sessionId: string;
  secret: string;
}

export function parseCookie(value: string): ParsedToken | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [tenantId, sessionId, secret] = parts as [string, string, string];
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(sessionId) || !/^[A-Za-z0-9_-]{43}$/.test(secret))
    return null;
  return { tenantId: tenantId.toLowerCase(), sessionId: sessionId.toLowerCase(), secret };
}

export function secretMatches(secret: string, storedHash: Buffer): boolean {
  const h = hashSecret(secret);
  return h.length === storedHash.length && timingSafeEqual(h, storedHash);
}
