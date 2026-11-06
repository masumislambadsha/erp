import { type DocTypeDef, type FieldDef, type Label, SYSTEM_COLUMNS } from './definition.js';

export interface FormField {
  name: string;
  label: Label;
  type: FieldDef['type'];
  required: boolean;
  help?: Label;
  options?: { value: string; label: Label }[];
  attrs: { maxLength?: number; min?: number; max?: number; integer?: boolean };
}
export interface FormSection {
  title: Label;
  fields: FormField[];
}

const toField = (f: FieldDef): FormField => ({
  name: f.name,
  label: f.label,
  type: f.type,
  required: f.required,
  ...(f.help ? { help: f.help } : {}),
  ...(f.options ? { options: f.options } : {}),
  attrs: {
    ...(f.maxLength !== undefined ? { maxLength: f.maxLength } : {}),
    ...(f.min !== undefined ? { min: f.min } : {}),
    ...(f.max !== undefined ? { max: f.max } : {}),
    ...(f.integer !== undefined ? { integer: f.integer } : {}),
  },
});

/** The form the web app draws: the type's own sections, or one section holding every field. */
export function formModel(def: DocTypeDef): FormSection[] {
  const byName = new Map(def.fields.map((f) => [f.name, f]));
  const sections = def.form?.sections ?? [
    { title: def.label, fields: def.fields.map((f) => f.name) },
  ];
  return sections.map((s) => ({
    title: s.title,
    fields: s.fields.map((n) => toField(byName.get(n)!)),
  }));
}

export interface ListColumn {
  key: string;
  label: Label;
  type: FieldDef['type'] | 'system';
}

const SYSTEM_LABELS: Record<(typeof SYSTEM_COLUMNS)[number], Label> = {
  number: { en: 'Number', bn: 'নম্বর' },
  status: { en: 'Status', bn: 'অবস্থা' },
  posting_date: { en: 'Date', bn: 'তারিখ' },
  party: { en: 'Party', bn: 'পক্ষ' },
};

/** Columns of the list screen: the type's choice, or number, date, status and the first fields. */
export function listModel(def: DocTypeDef): ListColumn[] {
  const keys = def.list?.columns ?? [
    'number',
    'posting_date',
    'status',
    ...def.fields.slice(0, 3).map((f) => f.name),
  ];
  const byName = new Map(def.fields.map((f) => [f.name, f]));
  return keys.map((k) => {
    const f = byName.get(k);
    if (f) return { key: k, label: f.label, type: f.type };
    return {
      key: k,
      label: SYSTEM_LABELS[k as (typeof SYSTEM_COLUMNS)[number]],
      type: 'system' as const,
    };
  });
}
