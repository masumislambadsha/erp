import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checksumOf,
  loadMigrations,
  MigrationError,
  type MigrationFile,
} from '../src/migrate/files.js';
import { plan } from '../src/migrate/runner.js';

const repo = join(import.meta.dirname, '../../..');

describe('migration files', () => {
  it('0001 is db/schema.sql byte for byte, and is the superuser-only file', () => {
    const migrations = loadMigrations(join(repo, 'db/migrations'));
    const first = migrations[0]!;
    expect(first.version).toBe('0001');
    expect(first.superuserOnly).toBe(true);
    const schema = readFileSync(join(repo, 'db/schema.sql'));
    const m0001 = readFileSync(join(repo, 'db/migrations', first.file));
    expect(m0001.equals(schema)).toBe(true);
    expect(first.checksum).toBe(checksumOf(schema));
  });

  it('rejects badly named files and duplicate versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, 'oops.sql'), 'select 1');
    expect(() => loadMigrations(dir)).toThrow(MigrationError);
    const dir2 = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir2, '0001_a.sql'), 'select 1');
    writeFileSync(join(dir2, '0001_b.sql'), 'select 2');
    expect(() => loadMigrations(dir2)).toThrow(/share version/);
  });
});

const f = (version: string, sql: string): MigrationFile => ({
  version,
  name: 'x',
  file: `${version}_x.sql`,
  sql,
  checksum: checksumOf(Buffer.from(sql)),
  superuserOnly: false,
});

describe('plan', () => {
  it('returns only unapplied files, in order', () => {
    const files = [f('0001', 'a'), f('0002', 'b'), f('0003', 'c')];
    const applied = [{ version: '0001', name: 'x', checksum: files[0]!.checksum }];
    expect(plan(files, applied).map((p) => p.version)).toEqual(['0002', '0003']);
  });
  it('refuses a changed file', () => {
    const applied = [{ version: '0001', name: 'x', checksum: checksumOf(Buffer.from('old')) }];
    expect(() => plan([f('0001', 'new')], applied)).toThrow(/changed after it was applied/);
  });
  it('refuses a vanished file', () => {
    const applied = [{ version: '0001', name: 'x', checksum: 'abc' }];
    expect(() => plan([], applied)).toThrow(/file is gone/);
  });
  it('refuses a new file numbered below an applied one', () => {
    const files = [f('0001', 'a'), f('0002', 'b')];
    const applied = [{ version: '0002', name: 'x', checksum: files[1]!.checksum }];
    expect(() => plan(files, applied)).toThrow(/apply in order|gone/);
  });
});
