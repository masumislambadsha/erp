import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '..');
const bin = join(repo, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');

/** Builds a throwaway repo layout and runs the real rule file against it. */
function cruise(files: Record<string, string>): { name: string; from: string; to: string }[] {
  const dir = mkdtempSync(join(tmpdir(), 'depcruise-'));
  cpSync(join(repo, '.dependency-cruiser.cjs'), join(dir, '.dependency-cruiser.cjs'));
  writeFileSync(
    join(dir, 'tsconfig.depcruise.json'),
    '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler"}}',
  );
  for (const d of ['apps', 'packages', 'packs']) mkdirSync(join(dir, d));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  let out: string;
  try {
    out = execFileSync(
      process.execPath,
      [
        bin,
        'apps',
        'packages',
        'packs',
        '--config',
        '.dependency-cruiser.cjs',
        '--output-type',
        'json',
      ],
      {
        cwd: dir,
        encoding: 'utf8',
      },
    );
  } catch (e) {
    out = (e as { stdout: string }).stdout; // non-zero exit when there are errors
    if (!out) throw e;
  }
  const report = JSON.parse(out);
  return report.summary.violations.map(
    (v: { rule: { name: string }; from: string; to: string }) => ({
      name: v.rule.name,
      from: v.from,
      to: v.to,
    }),
  );
}

describe('dependency rule: the core never imports a pack', () => {
  it('fails when code under apps/ imports from packs/', () => {
    const v = cruise({
      'apps/api/src/a.ts':
        "import { rent } from '../../../packs/rental/rent.js';\nexport const x = rent;\n",
      'packs/rental/rent.ts': 'export const rent = 1;\n',
    });
    expect(v).toEqual([
      { name: 'core-never-imports-a-pack', from: 'apps/api/src/a.ts', to: 'packs/rental/rent.ts' },
    ]);
  });

  it('fails when code under packages/ imports from packs/', () => {
    const v = cruise({
      'packages/db/src/a.ts':
        "import { rent } from '../../../packs/rental/rent.js';\nexport const x = rent;\n",
      'packs/rental/rent.ts': 'export const rent = 1;\n',
    });
    expect(v.map((x) => x.name)).toEqual(['core-never-imports-a-pack']);
  });

  it('allows a pack to import the core', () => {
    const v = cruise({
      'packages/db/src/money.ts': 'export const m = 1;\n',
      'packs/rental/rent.ts':
        "import { m } from '../../packages/db/src/money.js';\nexport const rent = m;\n",
    });
    expect(v).toEqual([]);
  });

  it('allows core to import core', () => {
    const v = cruise({
      'packages/db/src/money.ts': 'export const m = 1;\n',
      'apps/api/src/a.ts':
        "import { m } from '../../../packages/db/src/money.js';\nexport const x = m;\n",
    });
    expect(v).toEqual([]);
  });
});
