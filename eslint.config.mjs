import base from '@erp/config/eslint';

export default [
  ...base,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
  {
    // Everything outside packages/db reaches PostgreSQL only through withTenant (CLAUDE.md rule 2).
    files: ['apps/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: 'Use withTenant from @erp/db; only packages/db talks to pg.' },
            { name: 'drizzle-orm/node-postgres', message: 'Use withTenant from @erp/db.' },
          ],
        },
      ],
    },
  },
  {
    // Integration tests seed and clean up as the admin role, and prove raw access is refused.
    files: ['apps/**/test/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
];
