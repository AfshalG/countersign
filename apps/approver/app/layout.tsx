import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Countersign',
  description: 'Approve your agent’s payments with Face ID',
};

export const viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="bar">
          <a className="brand" href="/">
            Countersign
          </a>
          <nav aria-label="Main">
            <a href="/">Inbox</a>
            <a href="/orders">Suppliers</a>
            <a href="/account">Account</a>
            <a href="/connect">Connect</a>
          </nav>
        </header>
        <main className="page">{children}</main>
      </body>
    </html>
  );
}
