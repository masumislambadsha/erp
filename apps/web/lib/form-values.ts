import type { FormField } from '@erp/meta';

/** What a form input holds as text, and what the API expects. Money and dates stay strings. */
export function toPayload(
  fields: FormField[],
  state: Record<string, string | boolean>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = state[f.name];
    if (f.type === 'boolean') {
      if (v === true) out[f.name] = true;
      continue;
    }
    if (v === undefined || v === '') continue; // an empty optional field is absent; a required one fails validation
    out[f.name] = f.type === 'number' ? Number(v) : v;
  }
  return out;
}

export function fromValues(
  fields: FormField[],
  values: Record<string, unknown>,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of fields) {
    const v = values[f.name];
    out[f.name] =
      f.type === 'boolean' ? v === true : v === undefined || v === null ? '' : String(v);
  }
  return out;
}

export function showCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? '✓' : '';
  return String(value);
}
