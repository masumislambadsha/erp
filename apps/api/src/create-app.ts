import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { type Config, loadConfig } from './config.js';

/** Builds the app. Throws before anything is created if the configuration is unsafe. */
export async function createApp(
  env: Record<string, string | undefined> = process.env,
): Promise<{ app: INestApplication; config: Config }> {
  const config = loadConfig(env);
  const app = await NestFactory.create(AppModule.forRoot(config), { logger: ['error', 'warn'] });
  return { app, config };
}
