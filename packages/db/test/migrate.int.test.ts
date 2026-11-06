import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate/runner.js';
import { uuidv7 } from '../src/uuid7.js';
import { admin, env, withDatabase } from './helpers.js';

// Runs the real runner against a scratch database on the same server. The cluster's erp_* roles
// already exist (0001 ran on the main database), so these files only use erp_owner.
const scratch = `erp_mig_${uuidv7().replace(/-/g, '').slice(-12)}`;
const adminUrl = () => withDatabase(env('DATABASE_ADMIN_URL'), scratch);
let su: pg.Client;

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'erp-mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(d, name), sql);
  return d;
}

async function q<T extends pg.QueryResultRow>(sql: string, url = adminUrl()): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(sql)).rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  su = await admin();
  await su.query(`CREATE DATABASE ${scratch}`);
  await q('GRANT CREATE ON SCHEMA public TO erp_owner');
});
afterAll(async () => {
  await su.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
  await su.end();
});

describe('migration runner', () => {
  it('runs a normal file as erp_owner, a *.superuser.sql file as the superuser, and records checksums', async () => {
    const d = dir({
      '0001_boot.superuser.sql': 'CREATE TABLE made_by_super (x int);',
      '0002_plain.sql': 'CREATE TABLE made_by_owner (x int);',
    });
    expect(await migrate({ adminUrl: adminUrl(), dir: d })).toEqual([
      '0001_boot.superuser.sql',
      '0002_plain.sql',
    ]);
    const owners = await q<{ tablename: string; tableowner: string }>(
      "SELECT tablename, tableowner FROM pg_tables WHERE tablename LIKE 'made_by_%' ORDER BY 1",
    );
    const me = (await q<{ u: string }>('SELECT current_user u'))[0]!.u;
    expect(owners).toEqual([
      { tablename: 'made_by_owner', tableowner: 'erp_owner' },
      { tablename: 'made_by_super', tableowner: me },
    ]);
    const rec = await q<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM erp_migrations.schema_migration ORDER BY 1',
    );
    expect(rec.map((r) => r.version)).toEqual(['0001', '0002']);
    expect(rec[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('applies nothing the second time, and applies a new file after the recorded ones', async () => {
    const files = {
      '0001_boot.superuser.sql': 'CREATE TABLE made_by_super (x int);',
      '0002_plain.sql': 'CREATE TABLE made_by_owner (x int);',
    };
    expect(await migrate({ adminUrl: adminUrl(), dir: dir(files) })).toEqual([]);
    expect(
      await migrate({
        adminUrl: adminUrl(),
        dir: dir({ ...files, '0003_more.sql': 'CREATE TABLE more (x int);' }),
      }),
    ).toEqual(['0003_more.sql']);
  });

  it('refuses a file changed after it was applied', async () => {
    const d = dir({
      '0001_boot.superuser.sql': 'CREATE TABLE made_by_super (x int); -- edited',
      '0002_plain.sql': 'CREATE TABLE made_by_owner (x int);',
      '0003_more.sql': 'CREATE TABLE more (x int);',
    });
    await expect(migrate({ adminUrl: adminUrl(), dir: d })).rejects.toThrow(
      /changed after it was applied/,
    );
  });

  it('rolls back a failing file and records nothing for it', async () => {
    const d = dir({
      '0001_boot.superuser.sql': 'CREATE TABLE made_by_super (x int);',
      '0002_plain.sql': 'CREATE TABLE made_by_owner (x int);',
      '0003_more.sql': 'CREATE TABLE more (x int);',
      '0004_bad.sql': 'CREATE TABLE half_done (x int); SELECT 1/0;',
    });
    await expect(migrate({ adminUrl: adminUrl(), dir: d })).rejects.toThrow(/division by zero/);
    expect(await q("SELECT 1 FROM pg_tables WHERE tablename = 'half_done'")).toEqual([]);
    expect(await q("SELECT 1 FROM erp_migrations.schema_migration WHERE version = '0004'")).toEqual(
      [],
    );
  });

  it('refuses a normal file that leaves the erp_owner role', async () => {
    const d = dir({
      '0001_boot.superuser.sql': 'CREATE TABLE made_by_super (x int);',
      '0002_plain.sql': 'CREATE TABLE made_by_owner (x int);',
      '0003_more.sql': 'CREATE TABLE more (x int);',
      '0004_escape.sql': 'RESET ROLE; CREATE TABLE escaped (x int);',
    });
    await expect(migrate({ adminUrl: adminUrl(), dir: d })).rejects.toThrow(
      /left the erp_owner role/,
    );
    expect(await q("SELECT 1 FROM pg_tables WHERE tablename = 'escaped'")).toEqual([]);
  });

  it('refuses a superuser-only file when the connecting role is not a superuser', async () => {
    const role = `erp_it_nosu_${uuidv7().replace(/-/g, '').slice(-8)}`;
    await su.query(`CREATE ROLE ${role} LOGIN PASSWORD 'it-nosu-password' IN ROLE erp_owner`);
    try {
      await su.query(`GRANT CREATE ON DATABASE ${scratch} TO ${role}`);
      const u = new URL(adminUrl());
      u.username = role;
      u.password = 'it-nosu-password';
      const d = dir({
        '0001_boot.superuser.sql': 'CREATE TABLE made_by_super (x int);',
        '0002_plain.sql': 'CREATE TABLE made_by_owner (x int);',
        '0003_more.sql': 'CREATE TABLE more (x int);',
        '0005_needs_su.superuser.sql': 'CREATE TABLE needs_su (x int);',
      });
      // 0001-0003 are recorded; 0005 is pending and superuser-only.
      await expect(migrate({ adminUrl: u.toString(), dir: d })).rejects.toThrow(
        /needs a real superuser/,
      );
    } finally {
      await su.query(`REVOKE ALL ON DATABASE ${scratch} FROM ${role}`);
      await su.query(`DROP ROLE ${role}`);
    }
  });

  it('keeps schema_migration out of erp_app’s reach', async () => {
    const appUrl = withDatabase(env('DATABASE_URL'), scratch);
    await expect(q('SELECT * FROM erp_migrations.schema_migration', appUrl)).rejects.toThrow(
      /permission denied/,
    );
  });
});
