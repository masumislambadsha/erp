import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Config } from './config.js';
import { ContextGuard } from './context/context.guard.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { PartiesController } from './parties/parties.controller.js';
import { CONFIG } from './tokens.js';

@Module({})
export class AppModule {
  static forRoot(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [DatabaseModule],
      controllers: [HealthController, PartiesController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: APP_GUARD, useClass: ContextGuard },
      ],
      exports: [CONFIG],
      global: true,
    };
  }
}
