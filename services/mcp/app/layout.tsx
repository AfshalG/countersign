import type { ReactNode } from 'react';

export const metadata = { title: 'Countersign MCP server' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          maxWidth: '40rem',
          margin: '0 auto',
          padding: '1.5rem 1rem',
          lineHeight: 1.5,
        }}
      >
        {children}
      </body>
    </html>
  );
}
