'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '../../../lib/api';
import { pick, UI } from '../../../lib/labels';
import { showCell } from '../../../lib/form-values';
import { useLang } from '../../../components/Providers';
import type { DocTypeInfo } from '../../page';

interface Row {
  id: string;
  number: string | null;
  status: string;
  postingDate: string;
  partyName: string | null;
  values: Record<string, unknown>;
}

export default function DocList() {
  const { docType } = useParams<{ docType: string }>();
  const { lang } = useLang();
  const meta = useQuery({ queryKey: ['doc-type', docType], queryFn: () => api<DocTypeInfo>('GET', `/meta/doc-types/${docType}`) });
  const rows = useQuery({ queryKey: ['docs', docType], queryFn: () => api<{ rows: Row[] }>('GET', `/documents/${docType}`) });
  if (meta.error || rows.error) return <p>You cannot see this list.</p>;
  if (!meta.data || !rows.data) return <p>…</p>;
  const cell = (r: Row, key: string): string =>
    key === 'number' ? (r.number ?? '—') : key === 'status' ? r.status : key === 'posting_date' ? r.postingDate : key === 'party' ? (r.partyName ?? '') : showCell(r.values[key]);
  return (
    <main>
      <h1>{pick(meta.data.definition.label, lang)}</h1>
      <p><Link href={`/docs/${docType}/new`}>{pick(UI.newDoc!, lang)}</Link></p>
      {rows.data.rows.length === 0 ? (
        <p>{pick(UI.empty!, lang)}</p>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>{meta.data.list.map((c) => <th key={c.key} style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>{pick(c.label, lang)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.data.rows.map((r) => (
              <tr key={r.id}>
                {meta.data.list.map((c, i) => (
                  <td key={c.key} style={{ padding: '0.25rem 0' }}>{i === 0 ? <Link href={`/docs/${docType}/${r.id}`}>{cell(r, c.key) || '—'}</Link> : cell(r, c.key)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
