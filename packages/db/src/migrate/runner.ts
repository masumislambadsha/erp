import pg from 'pg';
import { loadMigrations, MigrationError, type MigrationFile } from './files.js';

const LOCK_KEY = 727274; // advisory lock: one migrator at a time

export interface MigrateOptions {
  /** A real superuser: 0001 creates roles, revokes pg_catalog function grants and changes function owners. */
  adminUrl: string;
  dir: string;
  log?: (line: string) => void;
}

export interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
}

/**
 * Forward-only SQL migrations. Each file runs in its own transaction together with the row that
 * records it (version, name, sha256). A file that changed after it was applied, a recorded file
 * that vanished, and a new file numbered below an applied one are all refused.
 *
 * Files named *.superuser.sql run as the connecting superuser. Every other file runs under
 * SET ROLE erp_owner, so the objects it creates belong to erp_owner. The record table lives in
 * its own schema, erp_migrations, which erp_app is never granted.
 */
export async function migrate(opts: MigrateOptions): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const files = loadMigrations(opts.dir);
  const client = new pg.Client({
    connectionString: opts.adminUrl,
    application_name: 'erp-migrate',
  });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    const isSuper =
      (await client.query("SELECT current_setting('is_superuser') AS su")).rows[0]?.su === 'on';
    let applied: AppliedRow[];
    try {
      await bootstrap(client);
      applied = await readApplied(client);
    } catch (err) {
      if (isSuper) throw err;
      throw new MigrationError(
        `the connecting role is not a superuser and cannot manage erp_migrations (${err instanceof Error ? err.message : err}). ` +
          'This role needs a real superuser; managed PostgreSQL without one (RDS, Supabase, Neon) will likely reject 0001. See the README.',
      );
    }
    const pending = plan(files, applied);

    const done: string[] = [];
    for (const f of pending) {
      await apply(client, f);
      log(`applied ${f.file}`);
      done.push(f.file);
    }
    if (done.length === 0) log('nothing to apply');
    return done;
  } finally {
    await client.end();
  }
}

/** Pure check of files against the record: returns the files still to apply, in order. */
export function plan(files: MigrationFile[], applied: AppliedRow[]): MigrationFile[] {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  for (const row of applied) {
    const f = byVersion.get(row.version);
    if (!f)
      throw new MigrationError(
        `migration ${row.version}_${row.name} was applied but its file is gone`,
      );
    if (f.checksum !== row.checksum) {
      throw new MigrationError(
        `migration ${f.file} changed after it was applied (recorded ${row.checksum.slice(0, 12)}, now ${f.checksum.slice(0, 12)}). Migrations are forward-only: add a new file.`,
      );
    }
  }
  const appliedVersions = new Set(applied.map((r) => r.version));
  const maxApplied =
    applied
      .map((r) => r.version)
      .sort()
      .at(-1) ?? '';
  const pending = files.filter((f) => !appliedVersions.has(f.version));
  for (const f of pending) {
    if (f.version < maxApplied) {
      throw new MigrationError(
        `${f.file} is numbered below the applied ${maxApplied}: migrations apply in order`,
      );
    }
  }
  return pending;
}

async function bootstrap(c: pg.Client): Promise<void> {
  await c.query(`
    CREATE SCHEMA IF NOT EXISTS erp_migrations;
    REVOKE ALL ON SCHEMA erp_migrations FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS erp_migrations.schema_migration (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      applied_by text NOT NULL DEFAULT session_user
    );
    REVOKE ALL ON TABLE erp_migrations.schema_migration FROM PUBLIC;`);
}

async function readApplied(c: pg.Client): Promise<AppliedRow[]> {
  const r = await c.query<AppliedRow>(
    'SELECT version, name, checksum FROM erp_migrations.schema_migration ORDER BY version',
  );
  return r.rows;
}

async function apply(c: pg.Client, f: MigrationFile): Promise<void> {
  if (f.superuserOnly) {
    const r = await c.query("SELECT current_setting('is_superuser') AS su");
    if (r.rows[0]?.su !== 'on') {
      throw new MigrationError(
        `${f.file} needs a real superuser (it creates roles, revokes pg_catalog function grants and changes function owners). ` +
          'Managed PostgreSQL without a superuser (RDS, Supabase, Neon) will likely reject it; see the README.',
      );
    }
  }
  await c.query('BEGIN');
  try {
    if (!f.superuserOnly) await c.query('SET LOCAL ROLE erp_owner');
    await c.query(f.sql);
    if (!f.superuserOnly) {
      const who = await c.query('SELECT current_user AS u');
      if (who.rows[0]?.u !== 'erp_owner') {
        throw new MigrationError(
          `${f.file} left the erp_owner role; only *.superuser.sql files may do that`,
        );
      }
      await c.query('RESET ROLE');
    }
    await c.query(
      'INSERT INTO erp_migrations.schema_migration (version, name, checksum) VALUES ($1, $2, $3)',
      [f.version, f.name, f.checksum],
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** Sets the login password of erp_app (a dev or deploy step; the SQL migration holds no secret). */
export async function setAppPassword(adminUrl: string, password: string): Promise<void> {
  if (password.length < 12)
    throw new MigrationError('ERP_APP_PASSWORD must be at least 12 characters');
  const c = new pg.Client({ connectionString: adminUrl, application_name: 'erp-migrate' });
  await c.connect();
  try {
    const r = await c.query<{ stmt: string }>(
      "SELECT format('ALTER ROLE erp_app PASSWORD %L', $1::text) AS stmt",
      [password],
    );
    await c.query(r.rows[0]!.stmt);
  } finally {
    await c.end();
  }
}
