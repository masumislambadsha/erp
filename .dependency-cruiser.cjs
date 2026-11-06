/**
 * Core is everything under apps/ and packages/. A pack lives in packs/ and extends the core only
 * through its declared extension points (PLAN.md, "The contract"). The core never imports a pack.
 */
module.exports = {
  forbidden: [
    {
      name: 'core-never-imports-a-pack',
      comment: 'CLAUDE.md rule 7 / PLAN.md rule 8: the core never depends on a pack.',
      severity: 'error',
      from: { path: '^(apps|packages)/' },
      to: { path: '^packs/' },
    },
    {
      name: 'apps-use-withtenant-not-pg',
      comment: 'Apps reach PostgreSQL only through withTenant in @erp/db (CLAUDE.md rule 2).',
      severity: 'error',
      from: { path: '^apps/', pathNot: '/test/' },
      to: {
        dependencyTypes: ['npm', 'npm-dev'],
        path: 'node_modules/(pg|drizzle-orm/node-postgres)(/|$)',
      },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    exclude: { path: '(^|/)(dist|\\.next|coverage)/' },
  },
};
