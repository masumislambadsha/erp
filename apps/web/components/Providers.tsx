'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Link from 'next/link';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { type Lang, pick, UI } from '../lib/labels';

const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({
  lang: 'en',
  setLang: () => {},
});
export const useLang = () => useContext(LangContext);

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
  );
  const [lang, setLangState] = useState<Lang>('en');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('erp-lang');
      if (saved === 'bn' || saved === 'en') setLangState(saved);
    } catch {
      /* storage can be unavailable; English stays */
    }
  }, []);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('erp-lang', l);
    } catch {
      /* ignore */
    }
  };
  return (
    <QueryClientProvider client={client}>
      <LangContext.Provider value={{ lang, setLang }}>
        <nav style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1.5rem' }}>
          <Link href="/">ERP</Link>
          <span style={{ flex: 1 }} />
          <button onClick={() => setLang(lang === 'en' ? 'bn' : 'en')}>
            {lang === 'en' ? 'বাংলা' : 'English'}
          </button>
          <button
            onClick={async () => {
              await api('POST', '/auth/sign-out').catch(() => {});
              window.location.href = '/login';
            }}
          >
            {pick(UI.signOut!, lang)}
          </button>
        </nav>
        {children}
      </LangContext.Provider>
    </QueryClientProvider>
  );
}
