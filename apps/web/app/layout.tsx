import type { ReactNode } from 'react';

export const metadata = { title: 'ERP', description: 'Ledger-first ERP for trading companies' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: '3rem auto', maxWidth: '40rem' }}>
        {children}
      </body>
    </html>
  );
}
