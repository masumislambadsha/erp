import { z } from 'zod';

/**
 * A document type defined only in metadata: its fields, form and list. The API validates every
 * write against it and the web app draws its screens from it, so one definition drives both.
 * Labels come in English and Bangla (PLAN.md, Definition of done).
 */
const Label = z.object({ en: z.string().min(1).max(120), bn: z.string().min(1).max(120) }).strict();
export type Label = z.infer<typeof Label>;

const Name = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'lower-case letters, digits and underscores');

export const FIELD_TYPES = [
  'text',
  'number',
  'money',
  'date',
  'boolean',
  'select',
  'party',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FieldDef = z
  .object({
    name: Name,
    label: Label,
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    help: Label.optional(),
    maxLength: z.number().int().min(1).max(2000).optional(), // text
    min: z.number().optional(), // number
    max: z.number().optional(), // number
    integer: z.boolean().optional(), // number
    options: z
      .array(z.object({ value: z.string().min(1).max(60), label: Label }).strict())
      .max(100)
      .optional(), // select
  })
  .strict();
export type FieldDef = z.infer<typeof FieldDef>;

const Section = z.object({ title: Label, fields: z.array(Name).min(1) }).strict();

/** Columns a list can show besides the type's own fields. */
export const SYSTEM_COLUMNS = ['number', 'status', 'posting_date', 'party'] as const;

export const DocTypeDef = z
  .object({
    label: Label,
    fields: z.array(FieldDef).max(100),
    lines: z
      .object({
        fields: z.array(FieldDef).max(30),
        minLines: z.number().int().min(0).max(1000).default(0),
      })
      .strict()
      .optional(),
    numbering: z
      .object({
        prefix: z
          .string()
          .regex(/^[A-Z0-9][A-Z0-9-]{0,9}$/, 'upper-case letters, digits and dashes, up to 10'),
      })
      .strict(),
    requiresParty: z.boolean().default(false),
    form: z
      .object({ sections: z.array(Section).min(1).max(20) })
      .strict()
      .optional(),
    list: z
      .object({ columns: z.array(z.string()).min(1).max(20) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path });
    const names = new Set<string>();
    d.fields.forEach((f, i) => {
      if (names.has(f.name)) issue(`duplicate field ${f.name}`, ['fields', i, 'name']);
      names.add(f.name);
    });
    for (const [where, fields] of [
      ['fields', d.fields],
      ['lines.fields', d.lines?.fields ?? []],
    ] as const) {
      fields.forEach((f, i) => {
        const path = where.split('.').concat(String(i));
        if (f.type === 'select' && !f.options?.length)
          issue(`select ${f.name} needs options`, [...path, 'options']);
        if (f.type !== 'select' && f.options)
          issue(`only a select takes options`, [...path, 'options']);
        if (f.type !== 'text' && f.maxLength !== undefined)
          issue('only text takes maxLength', [...path, 'maxLength']);
        if (
          f.type !== 'number' &&
          (f.min !== undefined || f.max !== undefined || f.integer !== undefined)
        )
          issue('only a number takes min, max and integer', path);
        if (f.min !== undefined && f.max !== undefined && f.min > f.max)
          issue('min is above max', [...path, 'min']);
        if (f.type === 'select') {
          const seen = new Set<string>();
          for (const o of f.options ?? []) {
            if (seen.has(o.value)) issue(`duplicate option ${o.value}`, [...path, 'options']);
            seen.add(o.value);
          }
        }
      });
    }
    const lineNames = new Set<string>();
    d.lines?.fields.forEach((f, i) => {
      if (lineNames.has(f.name))
        issue(`duplicate line field ${f.name}`, ['lines', 'fields', i, 'name']);
      lineNames.add(f.name);
    });
    d.form?.sections.forEach((s, si) =>
      s.fields.forEach((n, fi) => {
        if (!names.has(n))
          issue(`form names an unknown field ${n}`, ['form', 'sections', si, 'fields', fi]);
      }),
    );
    d.list?.columns.forEach((c, i) => {
      if (!names.has(c) && !(SYSTEM_COLUMNS as readonly string[]).includes(c))
        issue(`list names an unknown column ${c}`, ['list', 'columns', i]);
    });
  });
export type DocTypeDef = z.infer<typeof DocTypeDef>;

export const DOC_ACTIONS = ['read', 'create', 'update', 'submit', 'cancel', 'amend'] as const;
export type DocAction = (typeof DOC_ACTIONS)[number];
/** The permission names a document type adds: `<doc_type>:<action>`. */
export const docPermission = (docType: string, action: DocAction): string => `${docType}:${action}`;
export const docPermissions = (docType: string): string[] =>
  DOC_ACTIONS.map((a) => docPermission(docType, a));
