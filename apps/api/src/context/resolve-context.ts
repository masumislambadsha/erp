import { UUID_RE } from '@erp/db';
import type { Config } from '../config.js';
import type { RequestContext } from './request-context.js';

export const DEV_TENANT_HEADER = 'x-dev-tenant-id';
export const DEV_USER_HEADER = 'x-dev-user-id';

/**
 * Milestone 1 stub, replaced by the session in Milestone 2. Tenant and user come from headers
 * only when DEV_AUTH_STUB=true and NODE_ENV is not production. Otherwise the headers are ignored
 * and there is no context, so every protected route answers 401. (loadConfig also refuses to
 * start in production with the stub on; this check is the second lock.)
 */
export function resolveContext(
  config: Pick<Config, 'devAuthStub' | 'nodeEnv'>,
  headers: Record<string, string | string[] | undefined>,
): RequestContext | null {
  if (!config.devAuthStub || config.nodeEnv === 'production') return null;
  const tenantId = headers[DEV_TENANT_HEADER];
  const userId = headers[DEV_USER_HEADER];
  if (typeof tenantId !== 'string' || typeof userId !== 'string') return null;
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(userId)) return null;
  return { tenantId: tenantId.toLowerCase(), userId: userId.toLowerCase() };
}
