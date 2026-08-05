import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ReadonlyDbService } from '../db/readonly-db.service';
import { ReportRendererService } from '../reports/report-renderer.service';
import { AgentStoreService } from '../store/agent-store.service';
import { InvalidSqlError, SqlValidator } from '../sql/sql-validator';
import {
  REPORT_FORMATS,
  type QueryResult,
  type ReportFormat,
  type ReportRef,
} from '../agent.types';

export interface ToolContext {
  conversationId: string | null;
  userId: string | null;
}

/** Result of running a tool: `result` is JSON-serialised back to the model;
 * `report` (when set) tells the loop to emit a report_ready event. */
export interface ToolOutcome {
  result: unknown;
  report?: ReportRef;
}

const SYSTEM_TABLES = new Set([
  'migrations',
  'typeorm_metadata',
  'agent_conversations',
  'agent_reports',
  // The assistant's own plumbing. Exposing it invites the model to reason about
  // its own transcript, and ai_messages holds tool output it would then quote
  // back as if it were business data.
  'ai_messages',
  'ai_checks',
]);

@Injectable()
export class AgentToolsService {
  private readonly logger = new Logger(AgentToolsService.name);
  private readonly previewRows: number;
  private readonly rowLimit: number;
  private schemaCache: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly db: ReadonlyDbService,
    private readonly validator: SqlValidator,
    private readonly renderer: ReportRendererService,
    private readonly store: AgentStoreService,
  ) {
    this.previewRows = this.config.get<number>('agent.sqlPreviewRows', 50);
    this.rowLimit = this.config.get<number>('agent.sqlRowLimit', 5000);
  }

  /** Dispatch a tool call by name. Throws map to a tool_result error block. */
  async run(
    name: string,
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    switch (name) {
      case 'get_schema':
        return { result: { schema: await this.getSchema() } };
      case 'run_sql':
        return { result: await this.runSql(input) };
      case 'generate_report':
        return this.generateReport(input, ctx);
      case 'run_checks':
        return { result: await this.runChecks() };
      case 'get_geo':
        return { result: await this.getGeo(input) };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // --- get_schema ----------------------------------------------------------

  private async getSchema(): Promise<string> {
    if (this.schemaCache) return this.schemaCache;
    const res = await this.db.runSelect(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`,
      [],
      100_000,
    );
    const byTable = new Map<string, string[]>();
    for (const row of res.rows) {
      const table = String(row.table_name);
      if (SYSTEM_TABLES.has(table)) continue;
      const col = `${String(row.column_name)} ${String(row.data_type)}`;
      const cols = byTable.get(table) ?? [];
      cols.push(col);
      byTable.set(table, cols);
    }
    const lines = [...byTable.entries()].map(
      ([table, cols]) => `${table}(${cols.join(', ')})`,
    );
    this.schemaCache = lines.join('\n');
    return this.schemaCache;
  }

  // --- run_sql -------------------------------------------------------------

  private async runSql(input: unknown): Promise<unknown> {
    const sql = this.requireSql(input);
    let validated;
    try {
      validated = this.validator.validate(sql, this.rowLimit);
    } catch (err) {
      if (err instanceof InvalidSqlError) return { error: err.message };
      throw err;
    }
    // Pull only a preview into the model's context (memory still bounded by the
    // LIMIT the validator appended).
    const res = await this.db.runSelect(validated.sql, [], this.previewRows);
    return {
      columns: res.columns,
      rows: res.rows,
      previewRowCount: res.rowCount,
      hasMoreRows: res.truncated,
      note: res.truncated
        ? `Showing the first ${res.rowCount} rows. Use generate_report for the full set, or aggregate in SQL.`
        : undefined,
    };
  }

  // --- generate_report -----------------------------------------------------

  private async generateReport(
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const sql = this.requireSql(input);
    const format = (input as { format?: string }).format;
    const title =
      typeof (input as { title?: unknown }).title === 'string'
        ? (input as { title: string }).title.trim() || null
        : null;

    if (!this.isSupportedFormat(format)) {
      return {
        result: {
          error: `Unsupported format "${String(format)}". Supported formats: ${REPORT_FORMATS.join(', ')}. Tell the user in text that this format is not supported yet.`,
        },
      };
    }

    let validated;
    try {
      validated = this.validator.validate(sql, this.rowLimit);
    } catch (err) {
      if (err instanceof InvalidSqlError)
        return { result: { error: err.message } };
      throw err;
    }

    const res: QueryResult = await this.db.runSelect(
      validated.sql,
      [],
      this.rowLimit,
    );
    const rendered = await this.renderer.render(res, format, title);
    const filename = `${this.slug(title) || 'report'}.${rendered.extension}`;

    const report = await this.store.createReport(
      {
        conversationId: ctx.conversationId,
        createdBy: ctx.userId,
        title,
        format,
        filename,
        contentType: rendered.contentType,
        rowCount: res.rowCount,
        sqlText: validated.sql,
        buffer: rendered.buffer,
      },
      rendered.extension,
    );

    this.logger.log(
      `Generated ${format} report ${report.reportId} (${res.rowCount} rows)`,
    );

    return {
      report,
      result: {
        reportId: report.reportId,
        format: report.format,
        filename: report.filename,
        rowCount: report.rowCount,
        truncated: res.truncated,
        downloadUrl: report.downloadUrl,
        // Tiny preview so the model can describe what's inside.
        previewColumns: res.columns,
        previewRows: res.rows.slice(0, 5),
      },
    };
  }

  // --- run_checks (auditor) ------------------------------------------------

  /**
   * Run the enabled rows of the reviewed check battery.
   *
   * The model does NOT write these queries. A model asked to "find problems"
   * invents them; given a fixed battery it can only explain and rank what the
   * SQL actually returned. Each check is stored in ai_checks so an admin can
   * disable one without a deploy — and so a check that starts throwing can be
   * switched off without taking the whole auditor down with it.
   */
  private async runChecks(): Promise<unknown> {
    const defs = await this.db.runSelect(
      `SELECT key, title_ar, title_en, sql, severity
         FROM ai_checks
        WHERE enabled = true
        ORDER BY CASE severity
                   WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, key`,
      [],
      100,
    );

    const findings: Array<Record<string, unknown>> = [];
    for (const def of defs.rows) {
      const key = String(def.key);
      try {
        // Validated like any other statement: these rows are admin-editable, so
        // "it came from our own table" is not a reason to skip the check.
        const { sql } = this.validator.validate(String(def.sql), this.rowLimit);
        const res = await this.db.runSelect(sql, [], this.rowLimit);
        findings.push({
          key,
          severity: def.severity,
          title: { ar: def.title_ar, en: def.title_en },
          count: res.rows.length,
          sample: res.rows.slice(0, 5),
        });
      } catch (err) {
        // One broken check must not hide the other seven. Report it as a
        // failure so the auditor can say so rather than silently under-report.
        findings.push({
          key,
          severity: def.severity,
          title: { ar: def.title_ar, en: def.title_en },
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const clean = findings.every((f) => f.count === 0 && !f.error);
    return {
      ranAt: new Date().toISOString(),
      checksRun: findings.length,
      allClear: clean,
      findings,
    };
  }

  // --- get_geo (sales coach) -----------------------------------------------

  /**
   * Customers with their position, last visit and last sale, in one call.
   *
   * Exists because the alternative is the model writing a four-way join across
   * customers, customer_visits, voucher_headers and reps on every question
   * about the route — slower, and wrong in a new way each time.
   */
  private async getGeo(input: unknown): Promise<unknown> {
    const repId = (input as { repId?: unknown })?.repId;
    const params: unknown[] = [];
    let repFilter = '';
    if (typeof repId === 'string' && repId.length > 0) {
      params.push(repId);
      repFilter = `AND c.rep_id = $${params.length}::uuid`;
    }

    const res = await this.db.runSelect(
      `SELECT c.customer_number,
              COALESCE(c.name_ar, c.customer_name, c.name_en) AS customer_name,
              c.lat::float8  AS lat,
              c.lng::float8  AS lng,
              c.total_debt::numeric   AS total_debt,
              c.credit_limit::numeric AS credit_limit,
              COALESCE(r.name_ar, r.name_en) AS rep_name,
              v.last_visit,
              s.last_sale,
              s.sales_90d
         FROM customers c
         LEFT JOIN reps r ON r.id = c.rep_id
         LEFT JOIN LATERAL (
           SELECT max(cv.visited_at) AS last_visit
             FROM customer_visits cv
            WHERE cv.customer_id = c.id
         ) v ON true
         LEFT JOIN LATERAL (
           SELECT max(h.in_date) AS last_sale,
                  count(*) FILTER (
                    WHERE h.in_date >= now() - interval '90 days'
                  )::int AS sales_90d
             FROM voucher_headers h
            WHERE h.customer_number = c.customer_number
              AND h.trans_kind = 'SALE'
              AND h.is_posted = true
              AND h.deleted_at IS NULL
         ) s ON true
        WHERE c.deleted_at IS NULL
          AND c.is_active = true
          ${repFilter}
        ORDER BY s.last_sale ASC NULLS FIRST
        LIMIT 300`,
      params,
      300,
    );

    return {
      rowCount: res.rows.length,
      note: 'Ordered by least-recently-sold-to first. lat/lng are null where the customer was never pinned.',
      customers: res.rows,
    };
  }

  // --- helpers -------------------------------------------------------------

  private requireSql(input: unknown): string {
    const sql = (input as { sql?: unknown })?.sql;
    if (typeof sql !== 'string' || sql.trim().length === 0) {
      throw new InvalidSqlError('Missing required "sql" argument.');
    }
    return sql;
  }

  private isSupportedFormat(format: unknown): format is ReportFormat {
    return (
      typeof format === 'string' &&
      (REPORT_FORMATS as string[]).includes(format)
    );
  }

  private slug(title: string | null): string {
    if (!title) return '';
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
  }
}
