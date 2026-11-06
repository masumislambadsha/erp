import type { ReactNode } from 'react';
import { Providers } from '../components/Providers';

export const metadata = { title: 'ERP', description: 'Ledger-first ERP for trading companies' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          margin: '2rem auto',
          maxWidth: '60rem',
          padding: '0 1rem',
        }}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
