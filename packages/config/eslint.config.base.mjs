import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Shared rules. Money is never a JS number; raw database access stays in packages/db. */
export default tseslint.config(
  { ignores: ['**/*.cjs', '**/dist/**', '**/.next/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
);
