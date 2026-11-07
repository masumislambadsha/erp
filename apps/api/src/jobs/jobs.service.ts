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
} from '../observability/telemetry.js';
import { CONFIG } from '../tokens.js';
import { checkTenant, type TenantResult } from './integrity.js';
import { type DocumentSubmittedJob, QUEUES, type TenantIntegrityJob } from './queues.js';

/**
 * The workers: they run as erp_app, in the API process, and handle jobs one tenant at a time. They do
 * not supervise, expire or schedule anything (those need advisory locks): that is SchedulerService,
 * which runs as erp_scheduler.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private boss: PgBoss | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.jobsEnabled) return;
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
    await this.boss.work<TenantIntegrityJob>(
      QUEUES.integrityTenant,
      { pollingIntervalSeconds: 2, batchSize: 20 },
      (jobs) =>
        this.each(
          QUEUES.integrityTenant,
          jobs,
          async (j) => void (await this.runIntegrity(j.data.tenantId)),
        ),
    );
    log.info('job workers started');
  }

  async onApplicationShutdown(): Promise<void> {
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

  /** One tenant's integrity check. A difference is an alert, not a job failure: a failing job means the check could not run. */
  async runIntegrity(tenantId: string): Promise<TenantResult> {
    const r = await checkTenant(this.database, tenantId);
    integrityDifferences.record(r.differences, { tenant_id: tenantId });
    integrityLastRun.record(Math.floor(Date.now() / 1000));
    if (r.differences > 0)
      log.error('ledger integrity differences', {
        tenantId,
        differences: r.differences,
        first: r.detail.slice(0, 5),
      });
    else log.info('integrity check clean', { tenantId });
    return r;
  }
}
