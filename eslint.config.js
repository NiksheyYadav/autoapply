// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.next/**',
      'packages/db/migrations/**',
      '**/.venv/**',
      // esbuild-bundled Vercel function output (scripts/bundle-backend.mjs)
      // — vendored build artifact, not hand-written source.
      'api/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Enforced by the security model: no secrets or PII in stdout.
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['**/test/**/*.ts', '**/*.config.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
