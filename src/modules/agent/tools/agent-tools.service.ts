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
