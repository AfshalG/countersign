import { defineConfig } from 'tsdown';

// The SDK ships as one ESM file with types. The shared invoice ids, amounts, reason wording and
// EIP-712 types are bundled in (the workspace package is never published); viem stays a dependency.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'neutral',
  dts: { eager: true },
  clean: true,
  deps: { alwaysBundle: ['@countersign/shared'] },
});
