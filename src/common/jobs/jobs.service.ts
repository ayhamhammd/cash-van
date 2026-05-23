import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// pg-boss v9 uses `export = ...`; this CJS-style import is the right shape.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import PgBoss = require('pg-boss');

import { UserContext, UserContextService } from '../context/user-context.service';

export type EnqueueOptions = PgBoss.SendOptions & {
  /** Identifier visible in logs and pg-boss dashboard. */
  jobName?: string;
};

export interface JobPayload<T = unknown> {
  /** User context the job must run with. Captured at enqueue time so the
   * worker can re-establish CLS for audit log and role checks. */
  ctx: UserContext;
  /** Arbitrary, JSON-safe data. */
  data: T;
}

export type JobHandler<T = unknown> = (
  data: T,
  job: PgBoss.Job<JobPayload<T>>,
) => Promise<void>;

/**
 * Postgres-backed background job queue (pg-boss v9). No Redis required.
 *
 * Lifecycle:
 *   - On module init: connects, creates the pgboss schema if missing.
 *   - On shutdown:    stops cleanly.
 *
 * Enqueuing automatically captures the current user context so the worker
 * can re-establish CLS before running protected code (audit log, role guards).
 *
 * Disabled when `JOBS_ENABLED=false` (useful for tests / one-shot scripts).
 */
@Injectable()
export class JobsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private boss: PgBoss | null = null;
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly userCtx?: UserContextService,
  ) {
    this.enabled = config.get<boolean>('jobs.enabled', true);
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('Jobs disabled (JOBS_ENABLED=false). Skipping pg-boss.');
      return;
    }
    this.boss = new PgBoss({
      host: this.config.getOrThrow<string>('database.host'),
      port: this.config.getOrThrow<number>('database.port'),
      user: this.config.getOrThrow<string>('database.username'),
      password: this.config.getOrThrow<string>('database.password'),
      database: this.config.getOrThrow<string>('database.database'),
      ssl: this.config.get<boolean>('database.ssl')
        ? { rejectUnauthorized: false }
        : false,
      schema: 'pgboss',
      retentionDays: 14,
    });
    this.boss.on('error', (err: Error) =>
      this.logger.error(`pg-boss error: ${err.message}`, err.stack),
    );
    await this.boss.start();
    this.logger.log('pg-boss started');
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.boss) {
      await this.boss.stop({ graceful: true });
      this.boss = null;
    }
  }

  async enqueue<T>(
    queue: string,
    data: T,
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    if (!this.boss) return null;
    const ctx = this.userCtx?.get();
    if (!ctx) {
      throw new Error(
        `JobsService.enqueue(${queue}): no user context. Enqueue from inside an authenticated request or use UserContextService.runWith().`,
      );
    }
    const payload: JobPayload<T> = { ctx, data };
    return this.boss.send(queue, payload as unknown as object, options);
  }

  /**
   * Register a handler. The handler runs inside CLS populated with the
   * captured user context, so role checks and audit logs work as if the job
   * were a request from that user.
   */
  async register<T>(queue: string, handler: JobHandler<T>, concurrency = 1): Promise<void> {
    if (!this.boss) return;
    await this.boss.work<JobPayload<T>>(
      queue,
      { teamSize: concurrency, teamConcurrency: concurrency },
      async (job) => {
        const payload = job.data;
        if (!this.userCtx) {
          await handler(payload.data, job);
          return;
        }
        await this.userCtx.runWith(payload.ctx, () => handler(payload.data, job));
      },
    );
  }
}
