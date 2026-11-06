import { z } from 'zod';
import type { DocTypeDef, FieldDef } from './definition.js';

/**
 * Builds the validator for the values of a document (or a line) from its field definitions.
 * Money stays a decimal string, never a JS number: at most 15 integer digits and 4 decimals.
 */
const MONEY = /^-?\d{1,15}(\.\d{1,4})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isRealDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function fieldSchema(f: FieldDef): z.ZodType {
  let s: z.ZodType;
  switch (f.type) {
    case 'text': {
      let t = z.string().max(f.maxLength ?? 500);
      if (f.required) t = t.min(1);
      s = t;
      break;
    }
    case 'number': {
      let n = z.number().finite();
      if (f.integer) n = n.int();
      if (f.min !== undefined) n = n.min(f.min);
      if (f.max !== undefined) n = n.max(f.max);
      s = n;
      break;
    }
    case 'money':
      s = z.string().regex(MONEY, 'a decimal string with at most 4 decimals, e.g. "1250.50"');
      break;
    case 'date':
      s = z.string().refine(isRealDate, 'a real date as YYYY-MM-DD');
      break;
    case 'boolean':
      s = z.boolean();
      break;
    case 'select':
      s = z.enum((f.options ?? []).map((o) => o.value) as [string, ...string[]]);
      break;
    case 'party':
    case 'doc':
      s = z.uuid();
      break;
  }
  return f.required ? s : s.optional();
}

export function valuesSchema(fields: FieldDef[]): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) shape[f.name] = fieldSchema(f);
  return z.object(shape).strict() as unknown as z.ZodType<Record<string, unknown>>;
}

const DecimalQty = z
  .string()
  .regex(/^-?\d{1,13}(\.\d{1,6})?$/, 'a decimal string with at most 6 decimals');
const DecimalPrice = z.string().regex(/^-?\d{1,13}(\.\d{1,6})?$/);
const DecimalMoney = z.string().regex(MONEY);

/** A line carries the kernel's columns plus the type's own line fields in `values`. */
export function lineSchema(def: DocTypeDef) {
  return z
    .object({
      qty: DecimalQty,
      uom: z.string().min(1).max(20),
      unitPrice: DecimalPrice.optional(),
      discount: DecimalMoney.optional(),
      values: valuesSchema(def.lines?.fields ?? []).default({}),
    })
    .strict();
}

/** The body of a create or update: header columns, header values, lines. */
export function documentInputSchema(def: DocTypeDef) {
  return z
    .object({
      companyId: z.uuid(),
      postingDate: z.string().refine(isRealDate, 'a real date as YYYY-MM-DD'),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .default('BDT'),
      partyId: def.requiresParty ? z.uuid() : z.uuid().optional(),
      values: valuesSchema(def.fields).default({}),
      lines: def.lines ? z.array(lineSchema(def)).max(1000).default([]) : z.undefined().optional(),
    })
    .strict();
}
