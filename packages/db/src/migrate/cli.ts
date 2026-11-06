import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, setAppPassword } from './runner.js';

const defaultDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set (see .env.example)`);
    process.exit(2);
  }
  return v;
}

const cmd = process.argv[2];
try {
  if (cmd === 'migrate') {
    await migrate({
      adminUrl: need('DATABASE_ADMIN_URL'),
      dir: process.env.ERP_MIGRATIONS_DIR ?? defaultDir,
      log: (l) => console.log(l),
    });
  } else if (cmd === 'set-app-password') {
    await setAppPassword(need('DATABASE_ADMIN_URL'), need('ERP_APP_PASSWORD'));
    console.log('erp_app password set');
  } else {
    console.error('usage: erp-db migrate | set-app-password');
    process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
