import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DocTypeDef,
  docPermissions,
  documentInputSchema,
  formModel,
  isRealDate,
  listModel,
  valuesSchema,
} from '../src/index.js';

const L = (en: string) => ({ en, bn: `${en}-bn` });
const base = {
  label: L('Service order'),
  numbering: { prefix: 'SO-' },
  fields: [
    { name: 'title', label: L('Title'), type: 'text', required: true, maxLength: 50 },
    { name: 'fee', label: L('Fee'), type: 'money', required: true },
    { name: 'rooms', label: L('Rooms'), type: 'number', integer: true, min: 1, max: 20 },
    { name: 'due', label: L('Due'), type: 'date' },
    {
      name: 'kind',
      label: L('Kind'),
      type: 'select',
      options: [
        { value: 'a', label: L('A') },
        { value: 'b', label: L('B') },
      ],
    },
    { name: 'urgent', label: L('Urgent'), type: 'boolean' },
  ],
};
const def = () => DocTypeDef.parse(base);

describe('definition', () => {
  it('accepts a good definition and fills defaults', () => {
    const d = def();
    expect(d.requiresParty).toBe(false);
    expect(d.fields.find((f) => f.name === 'rooms')!.required).toBe(false);
  });

  it.each([
    [
      'unknown form field',
      { ...base, form: { sections: [{ title: L('s'), fields: ['nope'] }] } },
      /unknown field/,
    ],
    ['unknown list column', { ...base, list: { columns: ['nope'] } }, /unknown column/],
    ['duplicate field', { ...base, fields: [base.fields[0], base.fields[0]] }, /duplicate field/],
    [
      'select without options',
      { ...base, fields: [{ name: 'k', label: L('k'), type: 'select' }] },
      /needs options/,
    ],
    [
      'maxLength on a number',
      { ...base, fields: [{ name: 'k', label: L('k'), type: 'number', maxLength: 3 }] },
      /only text/,
    ],
    [
      'min above max',
      { ...base, fields: [{ name: 'k', label: L('k'), type: 'number', min: 5, max: 1 }] },
      /min is above max/,
    ],
    [
      'doc without refDocType',
      { ...base, fields: [{ name: 'k', label: L('k'), type: 'doc' }] },
      /needs refDocType/,
    ],
    [
      'refDocType on a text',
      { ...base, fields: [{ name: 'k', label: L('k'), type: 'text', refDocType: 'x' }] },
      /only a doc field/,
    ],
    ['bad prefix', { ...base, numbering: { prefix: 'so_' } }, /upper-case/],
    ['missing Bangla label', { ...base, label: { en: 'x' } }, /bn/],
    ['unknown key', { ...base, extra: 1 }, /Unrecognized/i],
    [
      'bad field name',
      { ...base, fields: [{ name: 'Bad Name', label: L('k'), type: 'text' }] },
      /lower-case/,
    ],
  ])('rejects %s', (_n, input, re) => {
    const r = DocTypeDef.safeParse(input);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(re);
  });

  it('names the permissions a type adds', () => {
    expect(docPermissions('service_order')).toEqual([
      'service_order:read',
      'service_order:create',
      'service_order:update',
      'service_order:submit',
      'service_order:cancel',
      'service_order:amend',
    ]);
  });
});

describe('values', () => {
  const s = valuesSchema(def().fields);
  const good = {
    title: 'Fix roof',
    fee: '1250.50',
    rooms: 3,
    due: '2026-12-31',
    kind: 'a',
    urgent: true,
  };

  it('accepts valid values', () => expect(s.safeParse(good).success).toBe(true));
  it('requires required fields and rejects unknown ones', () => {
    expect(s.safeParse({ fee: '1' }).success).toBe(false);
    expect(s.safeParse({ ...good, extra: 1 }).success).toBe(false);
  });
  it.each([
    ['text too long', { title: 'x'.repeat(51) }],
    ['empty required text', { title: '' }],
    ['money as a number', { fee: 12.5 }],
    ['money with 5 decimals', { fee: '1.23456' }],
    ['money in exponent form', { fee: '1e3' }],
    ['fractional integer', { rooms: 2.5 }],
    ['below min', { rooms: 0 }],
    ['above max', { rooms: 21 }],
    ['impossible date', { due: '2026-02-30' }],
    ['wrong date format', { due: '31/12/2026' }],
    ['unknown option', { kind: 'z' }],
    ['non-boolean', { urgent: 'yes' }],
  ])('rejects %s', (_n, patch) => expect(s.safeParse({ ...good, ...patch }).success).toBe(false));

  it('money strings of up to 15 integer digits and 4 decimals pass, and nothing else does', () => {
    const money = valuesSchema([{ name: 'm', label: L('m'), type: 'money', required: true }]);
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 999_999_999_999_999n }),
        fc.integer({ min: 0, max: 9999 }),
        (i, f) => {
          expect(money.safeParse({ m: `${i}.${String(f).padStart(4, '0')}` }).success).toBe(true);
        },
      ),
    );
    expect(money.safeParse({ m: '1000000000000000' }).success).toBe(false);
  });

  it('knows real dates', () => {
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
  });
});

describe('document input', () => {
  const lines = DocTypeDef.parse({
    ...base,
    requiresParty: true,
    lines: { fields: [{ name: 'note', label: L('Note'), type: 'text' }] },
  });
  const c = '11111111-1111-4111-8111-111111111111';
  it('takes lines only when the type has them, and a party when required', () => {
    const header = { companyId: c, postingDate: '2026-11-01', values: { title: 't', fee: '1' } };
    expect(documentInputSchema(def()).safeParse(header).success).toBe(true);
    expect(documentInputSchema(def()).safeParse({ ...header, lines: [] }).success).toBe(false);
    expect(documentInputSchema(lines).safeParse(header).success).toBe(false); // party required
    expect(
      documentInputSchema(lines).safeParse({
        ...header,
        partyId: c,
        lines: [{ qty: '2', uom: 'pcs', values: { note: 'x' } }],
      }).success,
    ).toBe(true);
    expect(
      documentInputSchema(lines).safeParse({
        ...header,
        partyId: c,
        lines: [{ qty: 2, uom: 'pcs' }],
      }).success,
    ).toBe(false); // qty as a number
  });
});

describe('form and list models', () => {
  it('draws one section of every field by default, and honours a declared form', () => {
    expect(formModel(def())).toHaveLength(1);
    expect(formModel(def())[0]!.fields.map((f) => f.name)).toEqual([
      'title',
      'fee',
      'rooms',
      'due',
      'kind',
      'urgent',
    ]);
    const d = DocTypeDef.parse({
      ...base,
      form: { sections: [{ title: L('Main'), fields: ['fee', 'title'] }] },
    });
    expect(formModel(d)[0]!.fields.map((f) => f.name)).toEqual(['fee', 'title']);
    expect(formModel(d)[0]!.fields[1]!.attrs).toEqual({ maxLength: 50 });
  });
  it('lists number, date, status and the first fields by default; mixes system and own columns', () => {
    expect(listModel(def()).map((c) => c.key)).toEqual([
      'number',
      'posting_date',
      'status',
      'title',
      'fee',
      'rooms',
    ]);
    const d = DocTypeDef.parse({ ...base, list: { columns: ['status', 'fee'] } });
    expect(listModel(d)).toEqual([
      { key: 'status', label: { en: 'Status', bn: 'অবস্থা' }, type: 'system' },
      { key: 'fee', label: L('Fee'), type: 'money' },
    ]);
  });
});
