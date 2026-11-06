import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { type Config, loadConfig } from './config.js';
import { httpTelemetry } from './observability/http.js';
import { JsonLogger } from './observability/logger.js';

/** Builds the app. Throws before anything is created if the configuration is unsafe. */
export async function createApp(
  env: Record<string, string | undefined> = process.env,
): Promise<{ app: INestApplication; config: Config }> {
  const config = loadConfig(env);
  const app = await NestFactory.create(AppModule.forRoot(config), { logger: new JsonLogger() });
  app.use(httpTelemetry);
  return { app, config };
}
