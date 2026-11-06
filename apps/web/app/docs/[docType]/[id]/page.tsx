'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { DocForm, type DocData } from '../../../../components/DocForm';
import { useLang } from '../../../../components/Providers';
import { api, ApiError, newKey } from '../../../../lib/api';
import { pick, UI } from '../../../../lib/labels';
import type { DocTypeInfo } from '../../../page';

interface Doc extends DocData {
  id: string;
  number: string | null;
  status: string;
  amendedFrom: string | null;
  amendedBy: string | null;
  actions: string[];
}

export default function DocPage() {
  const { docType, id } = useParams<{ docType: string; id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { lang } = useLang();
  const [error, setError] = useState('');
  const meta = useQuery({ queryKey: ['doc-type', docType], queryFn: () => api<DocTypeInfo>('GET', `/meta/doc-types/${docType}`) });
  const doc = useQuery({ queryKey: ['doc', id], queryFn: () => api<Doc>('GET', `/documents/${docType}/${id}`) });
  if (!meta.data || !doc.data) return <p>…</p>;
  const d = doc.data;

  async function act(action: 'submit' | 'cancel' | 'amend') {
    setError('');
    try {
      const r = await api<Doc>('POST', `/documents/${docType}/${id}/${action}`, undefined, newKey());
      await qc.invalidateQueries();
      if (action === 'amend') router.push(`/docs/${docType}/${r.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? [e.message, ...(e.body?.issues ?? []).map((i) => `${i.path}: ${i.message}`)].join(' · ') : 'Something went wrong');
    }
  }

  return (
    <main>
      <p><Link href={`/docs/${docType}`}>← {pick(meta.data.definition.label, lang)}</Link></p>
      <h1>{d.number ?? '(draft)'} <small>[{d.status}]</small></h1>
      {d.amendedFrom && <p>Amends <Link href={`/docs/${docType}/${d.amendedFrom}`}>an earlier document</Link></p>}
      {d.amendedBy && <p>Amended by <Link href={`/docs/${docType}/${d.amendedBy}`}>a newer document</Link></p>}
      <p style={{ display: 'flex', gap: '0.5rem' }}>
        {d.actions.includes('submit') && <button onClick={() => void act('submit')}>{pick(UI.submit!, lang)}</button>}
        {d.actions.includes('cancel') && <button onClick={() => void act('cancel')}>{pick(UI.cancel!, lang)}</button>}
        {d.actions.includes('amend') && <button onClick={() => void act('amend')}>{pick(UI.amend!, lang)}</button>}
        {d.actions.includes('delete') && (
          <button
            onClick={async () => {
              await api('DELETE', `/documents/${docType}/${id}`).catch(() => {});
              router.push(`/docs/${docType}`);
            }}
          >
            {pick(UI.delete!, lang)}
          </button>
        )}
      </p>
      {error && <p role="alert" style={{ color: 'crimson' }}>{error}</p>}
      <DocForm
        key={`${d.id}-${d.version}-${d.status}`}
        meta={meta.data}
        initial={d}
        readOnly={!d.actions.includes('update')}
        onSave={async (payload) => {
          await api('PATCH', `/documents/${docType}/${id}`, { ...payload, version: d.version }, newKey());
          await qc.invalidateQueries();
        }}
      />
    </main>
  );
}
