'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { DocTypeDef, FormSection, ListColumn } from '@erp/meta';
import { api } from '../lib/api';
import { pick } from '../lib/labels';
import { useLang } from '../components/Providers';

export interface DocTypeInfo {
  docType: string;
  version: number;
  isActive: boolean;
  definition: DocTypeDef;
  form: FormSection[];
  list: ListColumn[];
}

export default function Home() {
  const { lang } = useLang();
  const types = useQuery({
    queryKey: ['doc-types'],
    queryFn: () => api<DocTypeInfo[]>('GET', '/meta/doc-types'),
  });
  if (types.error)
    return (
      <p>
        Please <Link href="/login">sign in</Link>.
      </p>
    );
  return (
    <main>
      <h1>Documents</h1>
      <ul>
        {types.data
          ?.filter((t) => t.isActive)
          .map((t) => (
            <li key={t.docType}>
              <Link href={`/docs/${t.docType}`}>{pick(t.definition.label, lang)}</Link>
            </li>
          ))}
      </ul>
    </main>
  );
}
