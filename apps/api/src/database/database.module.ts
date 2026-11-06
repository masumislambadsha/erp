import { Module } from '@nestjs/common';
import { createDb } from '@erp/db';
import type { Config } from '../config.js';
import { CONFIG, DB } from '../tokens.js';
import { DatabaseService } from './database.service.js';

@Module({
  providers: [
    {
      provide: DB,
      inject: [CONFIG],
      useFactory: (c: Config) => createDb({ connectionString: c.databaseUrl }),
    },
    DatabaseService,
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}
