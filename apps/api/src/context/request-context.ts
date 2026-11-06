import type { Request } from 'express';
import type { RoleRules } from '../authz/rules.js';

/** Who is calling. The database layer takes both values from here and nowhere else. */
export interface RequestContext {
  tenantId: string;
  userId: string;
}

/** The nil UUID: the actor for work done before anyone has signed in (sign-in itself). */
export const NIL_USER = '00000000-0000-0000-0000-000000000000';

export interface AuthContext extends RequestContext {
  /** 'session' from the cookie; 'stub' only in development with DEV_AUTH_STUB=true. */
  via: 'session' | 'stub';
  sessionId: string | null;
  email: string;
  name: string;
  roleNames: string[];
  permissions: Set<string>;
  rules: RoleRules[];
  /** One of the user's roles requires TOTP. */
  mfaRequired: boolean;
  /** TOTP is not required, or this session has passed it. */
  mfaPassed: boolean;
  totpEnrolled: boolean;
}

export type RequestWithContext = Request & { erpAuth?: AuthContext };
