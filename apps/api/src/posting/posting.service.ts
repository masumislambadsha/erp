import { Injectable } from '@nestjs/common';
import { type Tx, uuidv7 } from '@erp/db';
import {
  DEFAULT_ROUNDING,
  PostingError,
  type ItemRef,
  type PostingPlan,
  type RoundingRule,
} from './plan.js';

export interface DocForPosting {
  id: string;
  tenantId: string;
  companyId: string;
  docType: string;
  postingDate: string;
  partyId: string | null;
  currency: string;
  ext: Record<string, unknown>;
  /** Set by the service: how this document's currency rounds. */
  rounding?: RoundingRule;
}

/** What a document type contributes: a plan for its journal. The service writes it. */
export interface PostingHandler {
  plan(tx: Tx, doc: DocForPosting): Promise<PostingPlan>;
}

/**
 * The only writer of ledgers (PLAN.md, "Module boundaries"). It runs inside the submit or cancel
 * transaction, so the document's number, its journal and its subledger rows commit together, and the
 * database checks the lot at COMMIT: the journal balances, control accounts match their subledgers,
 * a reversal mirrors, nothing posts into a locked period.
 */
@Injectable()
export class PostingService {
  private readonly handlers = new Map<string, PostingHandler>();

  register(docType: string, handler: PostingHandler): void {
    this.handlers.set(docType, handler);
  }

  handles(docType: string): boolean {
    return this.handlers.has(docType);
  }

  async post(tx: Tx, doc: DocForPosting): Promise<string | null> {
    const handler = this.handlers.get(doc.docType);
    if (!handler) return null; // a type with no posting handler is a pure document
    const base = await companyCurrency(tx, doc.companyId);
    if (doc.currency.trim() !== base)
      throw new PostingError(
        `documents post in the company currency (${base}) until foreign currency arrives`,
      );
    const rounding = await roundingFor(tx, doc.currency.trim());
    return this.write(tx, doc, await handler.plan(tx, { ...doc, rounding }), null);
  }

  /**
   * Cancels a posted document's effect with a mirror journal dated on the document's own date
   * (decision D10). Payments applied to its items must be unapplied by cancelling those documents first.
   */
  async reverse(tx: Tx, doc: DocForPosting): Promise<string | null> {
    const [orig] = await tx.query<{ id: string; posting_date: string }>(
      "SELECT id, posting_date::text FROM journal WHERE document_id = $1 AND kind = 'post'",
      [doc.id],
    );
    if (!orig) return null;
    const lines = await tx.query<{
      account_id: string;
      amount: string;
      party_id: string | null;
      item_id: string | null;
      dimension_set_id: string | null;
    }>(
      'SELECT account_id, amount::text, party_id, item_id, dimension_set_id FROM gl_line WHERE journal_id = $1 AND posting_date = $2',
      [orig.id, orig.posting_date],
    );
    const items = await tx.query<{
      id: string;
      side: 'receivable' | 'payable';
      party_id: string;
      account_id: string;
      amount: string;
    }>('SELECT id, side, party_id, account_id, amount::text FROM open_item WHERE journal_id = $1', [
      orig.id,
    ]);
    const applied = await tx.query<{
      id: string;
      debit_item_id: string;
      credit_item_id: string;
      amount: string;
    }>(
      "SELECT id, debit_item_id, credit_item_id, amount::text FROM settlement WHERE journal_id = $1 AND kind = 'apply'",
      [orig.id],
    );
    const plan: PostingPlan = {
      kind: 'reverse',
      postingDate: orig.posting_date,
      reversesJournalId: orig.id,
      lines: lines.map((l) => ({
        accountId: l.account_id,
        amount: negate(l.amount),
        ...(l.party_id ? { partyId: l.party_id } : {}),
      })),
      openItems: items.map((o) => ({
        key: `rev:${o.id}`,
        side: o.side,
        partyId: o.party_id,
        accountId: o.account_id,
        dueDate: orig.posting_date,
        amount: negate(o.amount),
      })),
      settlements: [
        // First undo what this document applied, then settle each of its items against its mirror.
        ...applied.map((s) => ({
          kind: 'unapply' as const,
          debit: { id: s.debit_item_id },
          credit: { id: s.credit_item_id },
          amount: s.amount,
          unappliesId: Number(s.id),
        })),
        ...items.map((o) =>
          Number(o.amount) > 0
            ? {
                kind: 'apply' as const,
                debit: { id: o.id },
                credit: { key: `rev:${o.id}` },
                amount: o.amount,
              }
            : {
                kind: 'apply' as const,
                debit: { key: `rev:${o.id}` },
                credit: { id: o.id },
                amount: negate(o.amount),
              },
        ),
      ],
    };
    // A document whose items were settled by another document cannot be cancelled until that one is.
    for (const o of items) {
      const [{ n } = { n: '0' }] = await tx.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM settlement WHERE (debit_item_id = $1 OR credit_item_id = $1) AND journal_id <> $2 AND kind = 'apply' AND NOT EXISTS (SELECT 1 FROM settlement u WHERE u.unapplies_id = settlement.id)",
        [o.id, orig.id],
      );
      if (Number(n) > 0)
        throw new PostingError(
          'this document was settled by another one (a receipt or credit note): cancel that first',
        );
    }
    return this.write(tx, doc, plan, orig.id);
  }

  private async write(
    tx: Tx,
    doc: DocForPosting,
    plan: PostingPlan,
    reverses: string | null,
  ): Promise<string> {
    const journalId = uuidv7();
    await tx.query(
      'INSERT INTO journal (tenant_id, id, company_id, posting_date, kind, document_id, reverses_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [doc.tenantId, journalId, doc.companyId, plan.postingDate, plan.kind, doc.id, reverses],
    );
    for (const l of plan.lines) {
      await tx.query(
        'INSERT INTO gl_line (tenant_id, journal_id, company_id, posting_date, account_id, amount, currency, amount_tc, party_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$8)',
        [
          doc.tenantId,
          journalId,
          doc.companyId,
          plan.postingDate,
          l.accountId,
          l.amount,
          doc.currency.trim(),
          l.partyId ?? null,
        ],
      );
    }
    const ids = new Map<string, string>();
    for (const o of plan.openItems) {
      const id = uuidv7();
      ids.set(o.key, id);
      await tx.query(
        `INSERT INTO open_item (tenant_id, id, journal_id, company_id, posting_date, party_id, side, account_id, due_date, currency, amount, amount_tc, remaining, remaining_tc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$11,$11)`,
        [
          doc.tenantId,
          id,
          journalId,
          doc.companyId,
          plan.postingDate,
          o.partyId,
          o.side,
          o.accountId,
          o.dueDate,
          doc.currency.trim(),
          o.amount,
        ],
      );
    }
    const resolve = (r: ItemRef): string => (r.id ?? ids.get(r.key ?? '')) as string;
    for (const s of plan.settlements) {
      await tx.query(
        `INSERT INTO settlement (tenant_id, journal_id, company_id, posting_date, kind, unapplies_id, debit_item_id, credit_item_id, amount, amount_tc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
        [
          doc.tenantId,
          journalId,
          doc.companyId,
          plan.postingDate,
          s.kind,
          s.unappliesId ?? null,
          resolve(s.debit),
          resolve(s.credit),
          s.amount,
        ],
      );
    }
    return journalId;
  }
}

const negate = (amount: string): string =>
  amount.startsWith('-') ? amount.slice(1) : `-${amount}`;

async function companyCurrency(tx: Tx, companyId: string): Promise<string> {
  const [c] = await tx.query<{ base_currency: string }>(
    'SELECT base_currency FROM company WHERE id = $1',
    [companyId],
  );
  return (c?.base_currency ?? '').trim();
}

/** The tenant's rounding for a currency; BDT's two places, half up, when nothing is set. */
async function roundingFor(tx: Tx, currency: string): Promise<RoundingRule> {
  const [r] = await tx.query<{ minor_unit: number; rounding_mode: RoundingRule['mode'] }>(
    'SELECT minor_unit, rounding_mode FROM currency_setting WHERE code = $1',
    [currency],
  );
  return r ? { minorUnit: r.minor_unit, mode: r.rounding_mode } : DEFAULT_ROUNDING;
}
