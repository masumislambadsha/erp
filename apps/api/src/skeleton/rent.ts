import { Injectable, type OnModuleInit, Inject } from '@nestjs/common';
import type { Tx } from '@erp/db';
import { DocTypeDef } from '@erp/meta';
import { resolveAccount } from '../posting/accounts.js';
import {
  type PostingPlan,
  PostingError,
  planRentInvoice,
  planRentReceipt,
} from '../posting/plan.js';
import {
  type DocForPosting,
  type PostingHandler,
  PostingService,
} from '../posting/posting.service.js';

/**
 * The walking skeleton for tenant zero: a rent invoice and a rent receipt, defined as ordinary
 * metadata document types, plus the two posting handlers that give them ledger effects. In Phase 2
 * this becomes the rental pack and moves out of the core; nothing here changes the kernel.
 */
const L = (en: string, bn: string) => ({ en, bn });

export const RENT_INVOICE = DocTypeDef.parse({
  label: L('Rent invoice', 'ভাড়ার চালান'),
  numbering: { prefix: 'RI-' },
  requiresParty: true,
  fields: [
    { name: 'room', label: L('Room', 'কক্ষ'), type: 'text', required: true, maxLength: 40 },
    { name: 'period_start', label: L('Period from', 'মেয়াদ শুরু'), type: 'date', required: true },
    { name: 'period_end', label: L('Period to', 'মেয়াদ শেষ'), type: 'date', required: true },
    {
      name: 'amount',
      label: L('Rent', 'ভাড়া'),
      type: 'money',
      required: true,
      help: L('Taka, up to 4 decimals', 'টাকা, ৪ দশমিক পর্যন্ত'),
    },
    { name: 'due_date', label: L('Due date', 'পরিশোধের তারিখ'), type: 'date', required: true },
    { name: 'note', label: L('Note', 'মন্তব্য'), type: 'text', maxLength: 500 },
  ],
  form: {
    sections: [
      {
        title: L('Rent', 'ভাড়া'),
        fields: ['room', 'period_start', 'period_end', 'amount', 'due_date'],
      },
      { title: L('Other', 'অন্যান্য'), fields: ['note'] },
    ],
  },
  list: { columns: ['number', 'posting_date', 'party', 'room', 'amount', 'status'] },
});

export const RENT_RECEIPT = DocTypeDef.parse({
  label: L('Rent receipt', 'ভাড়ার রসিদ'),
  numbering: { prefix: 'RR-' },
  requiresParty: true,
  fields: [
    {
      name: 'invoice',
      label: L('Invoice', 'চালান'),
      type: 'doc',
      required: true,
      refDocType: 'rent_invoice',
    },
    { name: 'amount', label: L('Amount received', 'প্রাপ্ত টাকা'), type: 'money', required: true },
    { name: 'reference', label: L('Reference', 'রেফারেন্স'), type: 'text', maxLength: 100 },
  ],
  list: { columns: ['number', 'posting_date', 'party', 'amount', 'status'] },
});

/** The accounts a rental tenant needs, as posting-setup events: posting code never names an account. */
export const RENT_EVENTS = { receivable: 'receivable', revenue: 'revenue', cash: 'cash' } as const;

async function partyGroup(tx: Tx, companyId: string, partyId: string): Promise<string | undefined> {
  const [r] = await tx.query<{ posting_group: string }>(
    "SELECT posting_group FROM party_role WHERE company_id = $1 AND party_id = $2 AND role = 'customer'",
    [companyId, partyId],
  );
  return r?.posting_group;
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new PostingError(`${what} is missing`);
  return v;
};

class RentInvoiceHandler implements PostingHandler {
  async plan(tx: Tx, doc: DocForPosting): Promise<PostingPlan> {
    if (!doc.partyId) throw new PostingError('a rent invoice needs a renter (party)');
    const groups = { partyGroup: await partyGroup(tx, doc.companyId, doc.partyId) };
    return planRentInvoice(
      {
        postingDate: doc.postingDate,
        partyId: doc.partyId,
        amount: str(doc.ext.amount, 'the rent'),
        dueDate: str(doc.ext.due_date, 'the due date'),
      },
      {
        receivable: await resolveAccount(tx, doc.companyId, RENT_EVENTS.receivable, groups),
        revenue: await resolveAccount(tx, doc.companyId, RENT_EVENTS.revenue, groups),
      },
      doc.rounding,
    );
  }
}

class RentReceiptHandler implements PostingHandler {
  async plan(tx: Tx, doc: DocForPosting): Promise<PostingPlan> {
    if (!doc.partyId) throw new PostingError('a rent receipt needs a renter (party)');
    const invoiceId = str(doc.ext.invoice, 'the invoice');
    const [inv] = await tx.query<{
      status: string;
      party_id: string | null;
      company_id: string;
      item_id: string | null;
      remaining: string | null;
    }>(
      `SELECT d.status, d.party_id, d.company_id, oi.id AS item_id, oi.remaining::text AS remaining
         FROM document d
         LEFT JOIN journal j ON j.document_id = d.id AND j.kind = 'post'
         LEFT JOIN open_item oi ON oi.journal_id = j.id
        WHERE d.id = $1 AND d.doc_type = 'rent_invoice'`,
      [invoiceId],
    );
    if (!inv || inv.status !== 'submitted' || !inv.item_id || inv.remaining === null)
      throw new PostingError('the invoice is not a submitted rent invoice');
    if (inv.company_id !== doc.companyId)
      throw new PostingError('the invoice belongs to another company');
    if (inv.party_id !== doc.partyId)
      throw new PostingError('the receipt and the invoice name different renters');
    const groups = { partyGroup: await partyGroup(tx, doc.companyId, doc.partyId) };
    return planRentReceipt(
      {
        postingDate: doc.postingDate,
        partyId: doc.partyId,
        amount: str(doc.ext.amount, 'the amount'),
        invoiceItemId: inv.item_id,
        invoiceRemaining: inv.remaining,
      },
      {
        cash: await resolveAccount(tx, doc.companyId, RENT_EVENTS.cash, groups),
        receivable: await resolveAccount(tx, doc.companyId, RENT_EVENTS.receivable, groups),
      },
      doc.rounding,
    );
  }
}

@Injectable()
export class RentPosting implements OnModuleInit {
  constructor(@Inject(PostingService) private readonly posting: PostingService) {}
  onModuleInit(): void {
    this.posting.register('rent_invoice', new RentInvoiceHandler());
    this.posting.register('rent_receipt', new RentReceiptHandler());
  }
}
