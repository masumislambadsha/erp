'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLang } from '../../../components/Providers';
import { api } from '../../../lib/api';

interface TB {
  rows: { accountId: string; code: string; name: string; debit: string; credit: string }[];
  totals: { debit: string; credit: string; balanced: boolean };
}

export default function TrialBalance() {
  const { lang } = useLang();
  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ id: string; name: string }[]>('GET', '/companies'),
  });
  const [companyId, setCompanyId] = useState('');
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const id = companyId || companies.data?.[0]?.id || '';
  const tb = useQuery({
    queryKey: ['tb', id, asOf],
    enabled: Boolean(id),
    queryFn: () => api<TB>('GET', `/reports/trial-balance?companyId=${id}&asOf=${asOf}`),
  });
  return (
    <main>
      <h1>{lang === 'bn' ? 'ট্রায়াল ব্যালেন্স' : 'Trial balance'}</h1>
      <p>
        <select value={id} onChange={(e) => setCompanyId(e.target.value)}>
          {companies.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>{' '}
        <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
      </p>
      {tb.error && <p>You cannot see this report.</p>}
      {tb.data && (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th align="left">Code</th>
              <th align="left">Account</th>
              <th align="right">Debit</th>
              <th align="right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {tb.data.rows.map((r) => (
              <tr key={r.accountId}>
                <td>{r.code}</td>
                <td>{r.name}</td>
                <td align="right">{r.debit}</td>
                <td align="right">{r.credit}</td>
              </tr>
            ))}
            <tr style={{ fontWeight: 'bold', borderTop: '1px solid #ccc' }}>
              <td />
              <td>Total {tb.data.totals.balanced ? '✓' : '✗ out of balance'}</td>
              <td align="right">{tb.data.totals.debit}</td>
              <td align="right">{tb.data.totals.credit}</td>
            </tr>
          </tbody>
        </table>
      )}
    </main>
  );
}
