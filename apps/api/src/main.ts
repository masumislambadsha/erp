import { createApp } from './create-app.js';
import { log } from './observability/logger.js';
import { startTelemetry } from './observability/setup.js';

const telemetry = startTelemetry();
try {
  const { app, config } = await createApp();
  app.enableShutdownHooks(); // SIGTERM: stop taking requests, let running jobs finish, close the pool
  await app.listen(config.port);
  log.info('api listening', { port: config.port, env: config.nodeEnv });
} catch (err) {
  log.error('api failed to start', { error: err instanceof Error ? err.message : String(err) });
  await telemetry.shutdown();
  process.exit(1);
}
