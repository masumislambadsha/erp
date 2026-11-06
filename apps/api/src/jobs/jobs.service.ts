import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import type { Tx } from '@erp/db';
import type { Config } from '../config.js';
import { NIL_USER } from '../context/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { log } from '../observability/logger.js';
import {
  integrityDifferences,
  integrityLastRun,
  jobsCompleted,
  jobsFailed,
  jobsStuck,
  partitionsMissing,
} from '../observability/telemetry.js';
import { CONFIG } from '../tokens.js';
import { checkTenant, listTenants, type TenantResult } from './integrity.js';
import { type DocumentSubmittedJob, type NightlyJob, QUEUES } from './queues.js';

const NIGHTLY_HOUR = 2; // Asia/Dhaka: after the day's postings, before anyone is at a desk

@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private boss: PgBoss | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.jobsEnabled) return;
    // erp_app runs the queue with schema, supervision and scheduling switched off: the schema and
    // queues come from migration 0004, and supervision and cron take advisory locks that erp_app
    // does not have. maintain() and tick() below do what they would, with plain SQL.
    this.boss = new PgBoss({
      connectionString: this.config.databaseUrl,
      schema: 'pgboss',
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
      persistQueueStats: false,
      persistWarnings: false,
      application_name: 'erp-jobs',
    });
    this.boss.on('error', (e: Error) => log.error('job queue error', { error: e.message }));
    await this.boss.start();
    await this.boss.work<DocumentSubmittedJob>(
      QUEUES.documentSubmitted,
      { pollingIntervalSeconds: 2 },
      (jobs) => this.each(QUEUES.documentSubmitted, jobs, (j) => this.onDocumentSubmitted(j.data)),
    );
    await this.boss.work<NightlyJob>(
      QUEUES.integrityNightly,
      { pollingIntervalSeconds: 5 },
      (jobs) =>
        this.each(QUEUES.integrityNightly, jobs, async () => void (await this.runIntegrity())),
    );
    await this.boss.work(QUEUES.maintenance, { pollingIntervalSeconds: 30 }, (jobs) =>
      this.each(QUEUES.maintenance, jobs, async () => void (await this.maintain())),
    );
    this.timer = setInterval(
      () =>
        void this.tick().catch((e: Error) =>
          log.error('scheduler tick failed', { error: e.message }),
        ),
      60_000,
    );
    this.timer.unref();
    void this.tick().catch(() => {});
    log.info('jobs started');
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.boss?.stop({ graceful: true, timeout: 10_000 });
  }

  /**
   * Queues a job in the caller's transaction: it exists if and only if the transaction commits, so a
   * rolled-back submit leaves no job and a committed one cannot lose it.
   */
  async enqueueIn<T extends object>(
    tx: Tx,
    queue: string,
    data: T,
    options: { singletonKey?: string; singletonSeconds?: number } = {},
  ): Promise<string | null> {
    if (!this.boss) return null; // JOBS_ENABLED=false
    return this.boss.send(queue, data, {
      ...options,
      db: { executeSql: (text: string, values?: unknown[]) => tx.execute(text, values) },
    });
  }

  /** Enqueues the nightly check once per Dhaka day, and housekeeping hourly. Safe on many instances: the singleton keys dedupe. */
  async tick(now: Date = new Date()): Promise<void> {
    if (!this.boss) return;
    const dhaka = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const part = (t: string) => dhaka.find((p) => p.type === t)!.value;
    const day = `${part('year')}-${part('month')}-${part('day')}`;
    if (Number(part('hour')) >= NIGHTLY_HOUR) {
      await this.database.withTenant(
        { tenantId: '00000000-0000-0000-0000-000000000000', userId: NIL_USER },
        (tx) =>
          this.enqueueIn(tx, QUEUES.integrityNightly, { day } satisfies NightlyJob, {
            singletonKey: day,
            singletonSeconds: 20 * 3600,
          }),
      );
    }
    await this.database.withTenant(
      { tenantId: '00000000-0000-0000-0000-000000000000', userId: NIL_USER },
      (tx) =>
        this.enqueueIn(
          tx,
          QUEUES.maintenance,
          {},
          { singletonKey: 'hourly', singletonSeconds: 3600 },
        ),
    );
  }

  private async each<T>(
    queue: string,
    jobs: { id: string; data: T }[],
    run: (job: { id: string; data: T }) => Promise<void>,
  ): Promise<void> {
    for (const job of jobs) {
      try {
        await run(job);
        jobsCompleted.add(1, { queue });
      } catch (e) {
        jobsFailed.add(1, { queue });
        log.error('job failed', { queue, jobId: job.id, error: (e as Error).message });
        throw e; // pg-boss retries with backoff, then marks it failed
      }
    }
  }

  private async onDocumentSubmitted(job: DocumentSubmittedJob): Promise<void> {
    // The first consumer of the post-commit event: confirm the document is still what the event says.
    const rows = await this.database.withTenant(
      { tenantId: job.tenantId, userId: NIL_USER },
      (tx) =>
        tx.query<{ status: string; number: string }>(
          'SELECT status, number FROM document WHERE id = $1',
          [job.documentId],
        ),
    );
    log.info('document submitted', {
      tenantId: job.tenantId,
      docType: job.docType,
      documentId: job.documentId,
      status: rows[0]?.status,
      number: rows[0]?.number,
    });
  }

  /** The nightly integrity check over every tenant. A difference is an alert, not a job failure: the job's own failure means it could not run. */
  async runIntegrity(): Promise<TenantResult[]> {
    const results: TenantResult[] = [];
    const errors: string[] = [];
    for (const tenantId of await listTenants(this.database)) {
      try {
        const r = await checkTenant(this.database, tenantId);
        results.push(r);
        if (r.differences > 0)
          log.error('ledger integrity differences', {
            tenantId,
            differences: r.differences,
            first: r.detail.slice(0, 5),
          });
      } catch (e) {
        errors.push(`${tenantId}: ${(e as Error).message}`);
        log.error('integrity check could not run', { tenantId, error: (e as Error).message });
      }
    }
    integrityDifferences.record(results.reduce((n, r) => n + r.differences, 0));
    if (errors.length === 0) integrityLastRun.record(Math.floor(Date.now() / 1000));
    log.info('integrity check finished', {
      tenants: results.length,
      differences: results.reduce((n, r) => n + r.differences, 0),
    });
    if (errors.length)
      throw new Error(
        `integrity check failed for ${errors.length} tenant(s): ${errors.join('; ')}`,
      );
    return results;
  }

  /** Deletes finished jobs past their retention and reports jobs stuck past their expiry (pg-boss would fail them if it could supervise). */
  async maintain(): Promise<{ deleted: number; stuck: number }> {
    return this.database.withTenant(
      { tenantId: '00000000-0000-0000-0000-000000000000', userId: NIL_USER },
      async (tx) => {
        const del = await tx.execute(
          "DELETE FROM pgboss.job WHERE state IN ('completed', 'cancelled', 'failed') AND keep_until < now()",
        );
        const stuck = await tx.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM pgboss.job WHERE state = 'active' AND started_on + make_interval(secs => expire_seconds) < now()",
        );
        const n = Number(stuck[0]?.n ?? 0);
        jobsStuck.record(n);
        if (n > 0) log.error('jobs stuck past their expiry', { count: n });
        // Ledger partitions: posting needs this year's and next year's. erp_app cannot create them, so an operator runs
        // `erp-db ensure-partitions`; here we only notice that one is missing.
        const year = new Date().getUTCFullYear();
        const missing = await tx.query<{ t: string }>(
          `SELECT t || '_' || y AS t FROM unnest(ARRAY['gl_line','stock_move','stock_value_entry','tax_line']) t, generate_series($1::int, $1::int + 1) y WHERE to_regclass('public.' || t || '_' || y) IS NULL`,
          [year],
        );
        partitionsMissing.record(missing.length);
        if (missing.length > 0)
          log.error('ledger partitions missing', { missing: missing.map((m) => m.t) });
        return { deleted: del.rowCount, stuck: n };
      },
    );
  }
}
