'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { DocForm } from '../../../../components/DocForm';
import { api, newKey } from '../../../../lib/api';
import type { DocTypeInfo } from '../../../page';

export default function NewDoc() {
  const { docType } = useParams<{ docType: string }>();
  const router = useRouter();
  const meta = useQuery({ queryKey: ['doc-type', docType], queryFn: () => api<DocTypeInfo>('GET', `/meta/doc-types/${docType}`) });
  if (!meta.data) return <p>…</p>;
  return (
    <main>
      <DocForm
        meta={meta.data}
        onSave={async (payload) => {
          const d = await api<{ id: string }>('POST', `/documents/${docType}`, payload, newKey());
          router.push(`/docs/${docType}/${d.id}`);
        }}
      />
    </main>
  );
}
