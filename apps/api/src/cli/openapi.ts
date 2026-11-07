// Writes docs/openapi.json from the routes themselves (no database needed). A test fails if the committed file is stale.
//   pnpm --filter @erp/api openapi
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../create-app.js';

const { app } = await createApp({
  DATABASE_URL: 'postgres://erp_app@localhost/none',
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  JOBS_ENABLED: 'false',
  NODE_ENV: 'test',
});
const server = await app.listen(0);
const url = await app.getUrl();
const spec = await (await fetch(`${url.replace('[::1]', 'localhost')}/openapi.json`)).json();
writeFileSync(
  resolve(import.meta.dirname, '../../../../docs/openapi.json'),
  `${JSON.stringify(spec, null, 2)}\n`,
);
await app.close();
void server;
console.log('wrote docs/openapi.json');
