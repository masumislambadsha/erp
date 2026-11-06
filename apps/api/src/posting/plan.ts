import { Money } from '@erp/db';

/**
 * A posting plan is data: what a document wants written to the ledgers. Planners are pure functions
 * (PLAN.md, "The submit pipeline", step 4); the posting service is the only code that writes it.
 * Every amount is a decimal string in company currency: debit positive, credit negative.
 */
export interface GlLinePlan {
  accountId: string;
  amount: string;
  partyId?: string;
}
export interface OpenItemPlan {
  key: string;
  side: 'receivable' | 'payable';
  partyId: string;
  accountId: string;
  dueDate: string;
  amount: string;
}
/** An item is named by its plan key (created in this journal) or by the id of one that exists. */
export interface ItemRef {
  key?: string;
  id?: string;
}
export interface SettlementPlan {
  kind: 'apply' | 'unapply';
  debit: ItemRef;
  credit: ItemRef;
  amount: string;
  /** Only for an unapply: the settlement it undoes. */
  unappliesId?: number;
}
export interface PostingPlan {
  kind: 'post' | 'reverse';
  postingDate: string;
  reversesJournalId?: string;
  lines: GlLinePlan[];
  openItems: OpenItemPlan[];
  settlements: SettlementPlan[];
}

export class PostingError extends Error {
  override name = 'PostingError';
}

export function assertPositive(amount: string, what: string): Money {
  const m = Money.of(amount);
  if (!m.gt('0')) throw new PostingError(`${what} must be above zero`);
  return m;
}

/** A plan must balance in company currency before it goes near the database, which checks it again at COMMIT. */
export function assertBalanced(plan: PostingPlan): void {
  const total = Money.sum(plan.lines.map((l) => Money.of(l.amount)));
  if (!total.isZero())
    throw new PostingError(`the posting does not balance (off by ${total.toString()})`);
}

export interface RentInvoiceInput {
  postingDate: string;
  partyId: string;
  amount: string;
  dueDate: string;
}
export interface RentInvoiceAccounts {
  receivable: string;
  revenue: string;
}

/** A rent invoice: the renter owes the amount (an open item on the receivable control account) and rent income is earned. */
export function planRentInvoice(i: RentInvoiceInput, a: RentInvoiceAccounts): PostingPlan {
  const amount = assertPositive(i.amount, 'the rent').toString();
  if (i.dueDate < i.postingDate) throw new PostingError('the due date is before the invoice date');
  const plan: PostingPlan = {
    kind: 'post',
    postingDate: i.postingDate,
    lines: [
      { accountId: a.receivable, amount, partyId: i.partyId },
      { accountId: a.revenue, amount: Money.of(amount).neg().toString() },
    ],
    openItems: [
      {
        key: 'invoice',
        side: 'receivable',
        partyId: i.partyId,
        accountId: a.receivable,
        dueDate: i.dueDate,
        amount,
      },
    ],
    settlements: [],
  };
  assertBalanced(plan);
  return plan;
}

export interface RentReceiptInput {
  postingDate: string;
  partyId: string;
  amount: string;
  invoiceItemId: string;
  invoiceRemaining: string;
}
export interface RentReceiptAccounts {
  cash: string;
  receivable: string;
}

/** A receipt: cash comes in, the renter's receivable falls, and the receipt's credit item settles the invoice's debit item. */
export function planRentReceipt(i: RentReceiptInput, a: RentReceiptAccounts): PostingPlan {
  const amount = assertPositive(i.amount, 'the receipt').toString();
  if (Money.of(amount).gt(i.invoiceRemaining)) {
    throw new PostingError(
      `the receipt (${amount}) is more than the ${i.invoiceRemaining} still owed on the invoice`,
    );
  }
  const plan: PostingPlan = {
    kind: 'post',
    postingDate: i.postingDate,
    lines: [
      { accountId: a.cash, amount },
      { accountId: a.receivable, amount: Money.of(amount).neg().toString(), partyId: i.partyId },
    ],
    openItems: [
      {
        key: 'receipt',
        side: 'receivable',
        partyId: i.partyId,
        accountId: a.receivable,
        dueDate: i.postingDate,
        amount: Money.of(amount).neg().toString(),
      },
    ],
    settlements: [
      { kind: 'apply', debit: { id: i.invoiceItemId }, credit: { key: 'receipt' }, amount },
    ],
  };
  assertBalanced(plan);
  return plan;
}
