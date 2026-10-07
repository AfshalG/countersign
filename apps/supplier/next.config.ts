import type { NextConfig } from 'next';

// A separate party's site (Kalibre Studio and a demo shop): no Countersign packages, plain pages.
const config: NextConfig = {
  typescript: { tsconfigPath: 'tsconfig.next.json' },
};

export default config;
