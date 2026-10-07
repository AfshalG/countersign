import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // dependencies/ holds Solidity libraries downloaded by Soldeer: not ours to lint.
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/dependencies/**',
      '**/.next/**',
      '**/next-env.d.ts',
      'contracts/**',
      '**/*.config.ts',
      'eslint.config.js',
      // Plain Node build scripts (no TypeScript project): packages/chain's ABI generator.
      '**/scripts/*.mjs',
      // Standalone projects a developer copies out; they install the SDK from its release.
      'examples/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  prettier,
);
