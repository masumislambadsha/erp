import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Type } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { buildOpenApi } from './openapi.js';
import { type Config, loadConfig } from './config.js';
import { httpTelemetry } from './observability/http.js';
import { JsonLogger } from './observability/logger.js';

/** Builds the app. Throws before anything is created if the configuration is unsafe. */
export async function createApp(
  env: Record<string, string | undefined> = process.env,
): Promise<{ app: INestApplication; config: Config }> {
  const config = loadConfig(env);
  const app = await NestFactory.create(AppModule.forRoot(config), { logger: new JsonLogger() });
  app.getHttpAdapter().getInstance().set('trust proxy', config.trustProxy); // the client's real IP, for the sign-in limit
  app.use(httpTelemetry);
  // The OpenAPI document, built from the routes themselves; it describes the API and holds no data.
  const spec = buildOpenApi(app, (AppModule.forRoot(config).controllers ?? []) as Type[]);
  app
    .getHttpAdapter()
    .get('/openapi.json', (_req: unknown, res: { json(b: unknown): void }) => res.json(spec));
  return { app, config };
}
