import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient } from 'pg';

import type { QueryResult } from '../agent.types';

/**
 * A dedicated, read-only Postgres connection pool for the report agent.
 *
 * Defence in depth around model-generated SQL:
 *  1. Connects as a separate `report_agent` role that only has SELECT grants
 *     (provisioned out-of-band via scripts/sql/report-agent-role.sql).
 *  2. Every statement runs inside a `READ ONLY` transaction with a
 *     `statement_timeout`, and the transaction is always ROLLed BACK — so even
 *     a query that slipped past validation can never commit a side effect.
 *
 * In development, if REPORT_DB_PASSWORD is unset it falls back to the main DB
 * credentials (the read-only transaction is still enforced) so the agent can
 * be tried without provisioning the role first.
 */
@Injectable()
export class ReadonlyDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReadonlyDbService.name);
  private pool!: Pool;
  private readonly statementTimeoutMs: number;
  private readonly rowLimit: number;

  constructor(private readonly config: ConfigService) {
    this.statementTimeoutMs = this.config.get<number>(
      'agent.sqlTimeoutMs',
      15000,
    );
    this.rowLimit = this.config.get<number>('agent.sqlRowLimit', 5000);
  }

  onModuleInit(): void {
    const reportUser = this.config.get<string>('reportDb.user', 'report_agent');
    const reportPassword = this.config.get<string>('reportDb.password', '');

    // Fall back to the main DB login only when no dedicated password is set
    // (dev convenience). Production validation requires REPORT_DB_PASSWORD.
    const useDedicated = reportPassword.length > 0;
    if (!useDedicated) {
      this.logger.warn(
        'REPORT_DB_PASSWORD not set — agent SQL will use the main DB role ' +
          '(read-only transaction still enforced). Provision report_agent for production.',
      );
    }

    this.pool = new Pool({
      host: this.config.get<string>('database.host'),
      port: this.config.get<number>('database.port'),
      database: this.config.get<string>('database.database'),
      user: useDedicated
        ? reportUser
        : this.config.get<string>('database.username'),
      password: useDedicated
        ? reportPassword
        : this.config.get<string>('database.password'),
      ssl: this.config.get<boolean>('database.ssl')
        ? { rejectUnauthorized: false }
        : false,
      max: 4,
      idleTimeoutMillis: 30_000,
      // Belt-and-suspenders: also enforce the timeout at the connection level.
      statement_timeout: this.statementTimeoutMs,
      query_timeout: this.statementTimeoutMs,
      application_name: 'vanflow-report-agent',
    });

    this.pool.on('error', (err) =>
      this.logger.error(`Idle report-agent client error: ${err.message}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  /**
   * Run a validated SELECT inside a read-only, auto-rolled-back transaction.
   * Rows beyond `maxRows` (defaults to the configured ceiling) are dropped and
   * `truncated` is set so callers can surface that to the user.
   */
  async runSelect(
    sql: string,
    params: unknown[] = [],
    maxRows: number = this.rowLimit,
  ): Promise<QueryResult> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION READ ONLY');
      await client.query(
        `SET LOCAL statement_timeout = ${this.statementTimeoutMs}`,
      );
      const res = await client.query({
        text: sql,
        values: params,
        rowMode: 'array',
      });

      const columns = (res.fields ?? []).map((f) => f.name);
      const allRows = (res.rows as unknown[][]) ?? [];
      const truncated = allRows.length > maxRows;
      const sliced = truncated ? allRows.slice(0, maxRows) : allRows;
      const rows = sliced.map((arr) => {
        const obj: Record<string, unknown> = {};
        columns.forEach((c, i) => {
          // Duplicate column names: last write wins (matches object semantics).
          obj[c] = arr[i];
        });
        return obj;
      });

      return { columns, rows, rowCount: sliced.length, truncated };
    } finally {
      // Always roll back: nothing the agent runs should ever persist.
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection already gone — pool will discard it */
      }
      client.release();
    }
  }
}
