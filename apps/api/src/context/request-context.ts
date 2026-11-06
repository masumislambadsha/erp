import type { Request } from 'express';

/** Who is calling. The database layer takes both values from here and nowhere else. */
export interface RequestContext {
  tenantId: string;
  userId: string;
}

export type RequestWithContext = Request & { erpContext?: RequestContext };
