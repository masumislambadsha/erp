import { createApp } from './create-app.js';

try {
  const { app, config } = await createApp();
  await app.listen(config.port);
  console.log(`api listening on :${config.port} (${config.nodeEnv})`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
