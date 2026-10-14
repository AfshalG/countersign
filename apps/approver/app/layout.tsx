import type { ReactNode } from 'react';
import { Geist, JetBrains_Mono, Sora } from 'next/font/google';
import { Dock } from './nav';
import './globals.css';

// Self-hosted at build time by next/font: no request to Google from the phone.
const sora = Sora({ variable: '--font-sora', subsets: ['latin'], display: 'swap' });
const geist = Geist({ variable: '--font-geist', subsets: ['latin'], display: 'swap' });
const mono = JetBrains_Mono({ variable: '--font-jetbrains', subsets: ['latin'], display: 'swap' });

export const metadata = {
  title: 'Countersign',
  description: 'AI agents can pay. Countersign makes sure only what you approved goes out.',
  appleWebApp: { capable: true, title: 'Countersign', statusBarStyle: 'black-translucent' },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#070912',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sora.variable} ${geist.variable} ${mono.variable}`}>
      <body>
        <div className="ambient" aria-hidden="true">
          <i />
          <i />
        </div>
        <header className="bar">
          <a className="brand" href="/" aria-label="Countersign, home">
            {/* The logo kit's wordmark for dark grounds (public/brand). */}
            <img src="/brand/countersign-logo.svg" alt="Countersign" width={148} height={24} />
          </a>
          <span className="net" title="Everything here is on Monad testnet, with test USDC">
            <span className="ping" aria-hidden="true" />
            MONAD TESTNET
          </span>
        </header>
        <main className="page">{children}</main>
        <Dock />
      </body>
    </html>
  );
}
