import type { NextConfig } from 'next';

const config: NextConfig = {
  typescript: { tsconfigPath: 'tsconfig.next.json' },
  // The SDK and the shared package are workspace packages written in TypeScript (Node ESM:
  // their imports name './client.js' for './client.ts').
  transpilePackages: ['@countersign/sdk', '@countersign/shared'],
  // Built with webpack (`next build --webpack`): Turbopack has no extensionAlias to map those
  // '.js' specifiers to the '.ts' sources (Next 16.2 docs: only resolveExtensions/resolveAlias).
  webpack: (webpackConfig: { resolve: { extensionAlias?: Record<string, string[]> } }) => {
    webpackConfig.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return webpackConfig;
  },
};

export default config;
