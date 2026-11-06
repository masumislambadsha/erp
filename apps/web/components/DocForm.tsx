'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormField } from '@erp/meta';
import { api } from '../lib/api';
import { fromValues, toPayload } from '../lib/form-values';
import { pick, UI } from '../lib/labels';
import type { DocTypeInfo } from '../app/page';
import { useLang } from './Providers';

export interface DocData {
  id?: string;
  version?: number;
  companyId?: string;
  postingDate?: string;
  partyId?: string | null;
  values?: Record<string, unknown>;
  lines?: {
    qty: string;
    uom: string;
    unitPrice?: string | null;
    values: Record<string, unknown>;
  }[];
}

interface LineState {
  qty: string;
  uom: string;
  unitPrice: string;
  values: Record<string, string | boolean>;
}

/** One renderer for every document type: the form comes from the metadata. */
export function DocForm({
  meta,
  initial,
  readOnly,
  onSave,
}: {
  meta: DocTypeInfo;
  initial?: DocData;
  readOnly?: boolean;
  onSave: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const { lang } = useLang();
  const allFields = meta.form.flatMap((s) => s.fields);
  const lineFields: FormField[] = (meta.definition.lines?.fields ?? []).map((f) => ({
    name: f.name,
    label: f.label,
    type: f.type,
    required: f.required,
    attrs: {},
    ...(f.options ? { options: f.options } : {}),
  }));
  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ id: string; name: string }[]>('GET', '/companies'),
  });
  const [companyId, setCompanyId] = useState(initial?.companyId ?? '');
  const [postingDate, setPostingDate] = useState(
    initial?.postingDate ?? new Date().toISOString().slice(0, 10),
  );
  const [partyId, setPartyId] = useState(initial?.partyId ?? '');
  const [state, setState] = useState(() => fromValues(allFields, initial?.values ?? {}));
  const [lines, setLines] = useState<LineState[]>(() =>
    (initial?.lines ?? []).map((l) => ({
      qty: l.qty,
      uom: l.uom,
      unitPrice: l.unitPrice ?? '',
      values: fromValues(lineFields, l.values),
    })),
  );
  const [error, setError] = useState('');

  const input = (f: FormField, value: string | boolean, set: (v: string | boolean) => void) => {
    const common = { id: f.name, disabled: readOnly, required: f.required };
    if (f.type === 'boolean')
      return (
        <input
          type="checkbox"
          {...common}
          checked={value === true}
          onChange={(e) => set(e.target.checked)}
        />
      );
    if (f.type === 'select')
      return (
        <select {...common} value={String(value)} onChange={(e) => set(e.target.value)}>
          <option value="" />
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {pick(o.label, lang)}
            </option>
          ))}
        </select>
      );
    const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
    return (
      <input
        type={type}
        {...common}
        value={String(value)}
        maxLength={f.attrs.maxLength}
        min={f.attrs.min}
        max={f.attrs.max}
        step={f.attrs.integer ? 1 : 'any'}
        inputMode={f.type === 'money' ? 'decimal' : undefined}
        onChange={(e) => set(e.target.value)}
      />
    );
  };

  async function submit() {
    setError('');
    const payload: Record<string, unknown> = {
      companyId,
      postingDate,
      ...(partyId ? { partyId } : {}),
      values: toPayload(allFields, state),
    };
    if (meta.definition.lines) {
      payload.lines = lines.map((l) => ({
        qty: l.qty,
        uom: l.uom,
        ...(l.unitPrice ? { unitPrice: l.unitPrice } : {}),
        values: toPayload(lineFields, l.values),
      }));
    }
    try {
      await onSave(payload);
    } catch (e) {
      const err = e as {
        message?: string;
        body?: { issues?: { path: string; message: string }[] };
      };
      setError(
        [err.message, ...(err.body?.issues ?? []).map((i) => `${i.path}: ${i.message}`)]
          .filter(Boolean)
          .join(' · '),
      );
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      style={{ display: 'grid', gap: '1rem' }}
    >
      <fieldset disabled={readOnly}>
        <legend>{pick(meta.definition.label, lang)}</legend>
        <label>
          {pick(UI.company!, lang)}{' '}
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} required>
            <option value="" />
            {companies.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          {pick(UI.date!, lang)}{' '}
          <input
            type="date"
            value={postingDate}
            onChange={(e) => setPostingDate(e.target.value)}
            required
          />
        </label>{' '}
        <label>
          {pick(UI.party!, lang)}{' '}
          <input
            value={partyId}
            onChange={(e) => setPartyId(e.target.value)}
            required={meta.definition.requiresParty}
          />
        </label>
      </fieldset>
      {meta.form.map((s, i) => (
        <fieldset key={i} disabled={readOnly}>
          <legend>{pick(s.title, lang)}</legend>
          <div
            style={{
              display: 'grid',
              gap: '0.5rem',
              gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
            }}
          >
            {s.fields.map((f) => (
              <label key={f.name} title={f.help ? pick(f.help, lang) : undefined}>
                {pick(f.label, lang)}
                {f.required ? ' *' : ''}
                <br />
                {input(f, state[f.name] ?? '', (v) => setState({ ...state, [f.name]: v }))}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      {meta.definition.lines && (
        <fieldset disabled={readOnly}>
          <legend>{pick(UI.lines!, lang)}</legend>
          {lines.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input
                placeholder="qty"
                value={l.qty}
                onChange={(e) =>
                  setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))
                }
                required
                size={6}
              />
              <input
                placeholder="uom"
                value={l.uom}
                onChange={(e) =>
                  setLines(lines.map((x, j) => (j === i ? { ...x, uom: e.target.value } : x)))
                }
                required
                size={6}
              />
              <input
                placeholder="price"
                value={l.unitPrice}
                onChange={(e) =>
                  setLines(lines.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))
                }
                size={8}
              />
              {lineFields.map((f) => (
                <span key={f.name}>
                  {input(f, l.values[f.name] ?? '', (v) =>
                    setLines(
                      lines.map((x, j) =>
                        j === i ? { ...x, values: { ...x.values, [f.name]: v } } : x,
                      ),
                    ),
                  )}
                </span>
              ))}
              <button type="button" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setLines([...lines, { qty: '', uom: '', unitPrice: '', values: {} }])}
          >
            {pick(UI.addLine!, lang)}
          </button>
        </fieldset>
      )}
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
      {!readOnly && <button type="submit">{pick(UI.save!, lang)}</button>}
    </form>
  );
}
