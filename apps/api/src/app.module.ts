import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AccountsController } from './accounts/accounts.controller.js';
import { AuditController } from './audit/audit.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { SessionService } from './auth/session.service.js';
import type { Config } from './config.js';
import { DatabaseModule } from './database/database.module.js';
import { DocumentsController } from './documents/documents.controller.js';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor.js';
import { MetaController } from './meta/meta.controller.js';
import { HealthController } from './health/health.controller.js';
import { PartiesController } from './parties/parties.controller.js';
import { RolesController } from './roles/roles.controller.js';
import { CONFIG } from './tokens.js';
import { UsersController } from './users/users.controller.js';

@Module({})
export class AppModule {
  static forRoot(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [DatabaseModule],
      controllers: [
        HealthController,
        AuthController,
        UsersController,
        RolesController,
        PartiesController,
        AccountsController,
        AuditController,
        MetaController,
        DocumentsController,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        SessionService,
        AuthService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
      exports: [CONFIG],
      global: true,
    };
  }
}
