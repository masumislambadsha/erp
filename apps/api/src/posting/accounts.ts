import type { Tx } from '@erp/db';
import { PostingError } from './plan.js';

export interface Groups {
  partyGroup?: string;
  productGroup?: string;
  locationGroup?: string;
}

/**
 * Posting code asks for an account by event name and never names one (PLAN.md rule 7: accounts are
 * data). Among the posting_setup rows for the event, the one with the most exact matches wins; a
 * wildcard '*' matches anything.
 */
export async function resolveAccount(
  tx: Tx,
  companyId: string,
  event: string,
  groups: Groups = {},
): Promise<string> {
  const rows = await tx.query<{ account_id: string; score: number }>(
    `SELECT account_id,
            (party_group <> '*')::int + (product_group <> '*')::int + (location_group <> '*')::int AS score
       FROM posting_setup
      WHERE company_id = $1 AND event = $2
        AND party_group IN ('*', $3) AND product_group IN ('*', $4) AND location_group IN ('*', $5)
      ORDER BY score DESC`,
    [
      companyId,
      event,
      groups.partyGroup ?? '*',
      groups.productGroup ?? '*',
      groups.locationGroup ?? '*',
    ],
  );
  if (rows.length === 0)
    throw new PostingError(
      `no posting setup for "${event}" in this company: set it up before posting`,
    );
  if (
    rows.length > 1 &&
    rows[0]!.score === rows[1]!.score &&
    rows[0]!.account_id !== rows[1]!.account_id
  ) {
    throw new PostingError(`posting setup for "${event}" is ambiguous`);
  }
  return rows[0]!.account_id;
}
