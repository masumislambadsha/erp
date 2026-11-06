import pg from 'pg';

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set for integration tests (see .env.example)`);
  return v;
}

/** Same server, another database. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** A raw superuser connection, for seeding and cleanup only. Never used by the code under test. */
export async function admin(url = env('DATABASE_ADMIN_URL')): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}
