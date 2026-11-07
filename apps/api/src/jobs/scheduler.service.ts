import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import type { Config } from '../config.js';
import { log } from '../observability/logger.js';
import { jobsStuck, partitionsMissing } from '../observability/telemetry.js';
import { CONFIG } from '../tokens.js';
import { QUEUES, type TenantIntegrityJob } from './queues.js';

export const NIGHTLY_CRON = '0 2 * * *'; // 02:00
export const NIGHTLY_TZ = 'Asia/Dhaka';

/**
 * The job supervisor, the only code that connects as erp_scheduler. It lets pg-boss do its own supervision
 * (expire jobs whose worker died, apply retention) and cron, which take advisory locks, and it fans the
 * nightly integrity check out to one job per tenant. It reads the tenant ids in platform_tenant and the
 * pgboss schema, and nothing else: it cannot read a business table, so it never sees a tenant's books.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private boss: PgBoss | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.jobsEnabled) return;
    if (!this.config.schedulerUrl) {
      log.warn(
        'DATABASE_SCHEDULER_URL is not set: stuck jobs will not recover and the nightly check is not scheduled',
      );
      return;
    }
    this.boss = new PgBoss({
      connectionString: this.config.schedulerUrl,
      schema: 'pgboss',
      migrate: false,
      createSchema: false,
      supervise: true,
      schedule: true,
      persistQueueStats: false, // that table needs a new partition each day, which is DDL
      persistWarnings: false,
      application_name: 'erp-scheduler',
    });
    this.boss.on('error', (e: Error) => log.error('scheduler queue error', { error: e.message }));
    await this.boss.start();
    await this.boss.work<Record<string, never>>(
      QUEUES.integrityNightly,
      { pollingIntervalSeconds: 10 },
      async () => void (await this.fanOut()),
    );
    await this.boss.schedule(QUEUES.integrityNightly, NIGHTLY_CRON, {}, { tz: NIGHTLY_TZ });
    this.timer = setInterval(
      () =>
        void this.observe().catch((e: Error) =>
          log.error('scheduler observe failed', { error: e.message }),
        ),
      5 * 60_000,
    );
    this.timer.unref();
    void this.observe().catch(() => {});
    log.info('job supervisor started', { cron: NIGHTLY_CRON, tz: NIGHTLY_TZ });
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.boss?.stop({ graceful: true, timeout: 10_000 });
  }

  /** pg-boss's own supervision pass, on demand (it also runs on its timer). */
  async supervise(): Promise<void> {
    await this.boss?.supervise();
  }

  /** One integrity job per tenant, once per Dhaka day each. Returns how many tenants were queued. */
  async fanOut(now: Date = new Date()): Promise<number> {
    if (!this.boss) return 0;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: NIGHTLY_TZ }).format(now);
    const { rows } = await this.boss
      .getDb()
      .executeSql('SELECT id FROM platform_tenant ORDER BY id');
    for (const { id } of rows as { id: string }[]) {
      await this.boss.send(
        QUEUES.integrityTenant,
        { tenantId: id, day } satisfies TenantIntegrityJob,
        { singletonKey: `${id}:${day}`, singletonSeconds: 20 * 3600 },
      );
    }
    log.info('integrity check fanned out', { tenants: rows.length, day });
    return rows.length;
  }

  /** Gauges that raise alerts: jobs stuck past their expiry (should be zero now supervision runs), and missing ledger partitions. */
  async observe(): Promise<{ stuck: number; missing: string[] }> {
    if (!this.boss) return { stuck: 0, missing: [] };
    const db = this.boss.getDb();
    const stuck = Number(
      (
        (
          await db.executeSql(
            "SELECT count(*)::int AS n FROM pgboss.job WHERE state = 'active' AND started_on + make_interval(secs => expire_seconds) < now() - interval '5 minutes'",
          )
        ).rows[0] as { n: number }
      ).n,
    );
    jobsStuck.record(stuck);
    if (stuck > 0) log.error('jobs stuck past their expiry', { count: stuck });
    // This year's and next year's partitions must exist; erp_app cannot create them, so a deploy does (ensure-partitions).
    const year = new Date().getUTCFullYear();
    const missing = (
      (
        await db.executeSql(
          `SELECT t || '_' || y AS t FROM unnest(ARRAY['gl_line','stock_move','stock_value_entry','tax_line']) t, generate_series($1::int, $1::int + 1) y WHERE to_regclass('public.' || t || '_' || y) IS NULL`,
          [year],
        )
      ).rows as { t: string }[]
    ).map((r) => r.t);
    partitionsMissing.record(missing.length);
    if (missing.length > 0) log.error('ledger partitions missing', { missing });
    return { stuck, missing };
  }
}
