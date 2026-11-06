import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export class MigrationError extends Error {
  override name = 'MigrationError';
}

export interface MigrationFile {
  version: string; // "0001"
  name: string; // "kernel"
  file: string; // "0001_kernel.superuser.sql"
  sql: string;
  checksum: string; // sha256 of the file's exact bytes
  /** Runs as the connecting superuser. Every other file runs under SET ROLE erp_owner. */
  superuserOnly: boolean;
}

// NNNN_snake_name.sql, or NNNN_snake_name.superuser.sql for a file that needs a real superuser.
const FILE_RE = /^(\d{4})_([a-z0-9_]+?)(\.superuser)?\.sql$/;

export function checksumOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function loadMigrations(dir: string): MigrationFile[] {
  const out: MigrationFile[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const m = FILE_RE.exec(file);
    if (!m) throw new MigrationError(`bad migration file name: ${file} (want 0001_name.sql)`);
    const bytes = readFileSync(join(dir, file));
    out.push({
      version: m[1]!,
      name: m[2]!,
      file,
      sql: bytes.toString('utf8'),
      checksum: checksumOf(bytes),
      superuserOnly: m[3] !== undefined,
    });
  }
  const seen = new Set<string>();
  for (const f of out) {
    if (seen.has(f.version)) throw new MigrationError(`two migrations share version ${f.version}`);
    seen.add(f.version);
  }
  return out;
}
