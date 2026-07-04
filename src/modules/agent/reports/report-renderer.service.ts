import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

import type { QueryResult, ReportFormat } from '../agent.types';

export interface RenderedReport {
  buffer: Buffer;
  contentType: string;
  extension: string;
}

const CONTENT_TYPE: Record<ReportFormat, string> = {
  text: 'text/plain; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const EXTENSION: Record<ReportFormat, string> = {
  text: 'txt',
  markdown: 'md',
  json: 'json',
  xlsx: 'xlsx',
};

/** Renders a query result into a downloadable artifact. */
@Injectable()
export class ReportRendererService {
  async render(
    result: QueryResult,
    format: ReportFormat,
    title: string | null,
  ): Promise<RenderedReport> {
    const buffer = await this.toBuffer(result, format, title);
    return {
      buffer,
      contentType: CONTENT_TYPE[format],
      extension: EXTENSION[format],
    };
  }

  private async toBuffer(
    result: QueryResult,
    format: ReportFormat,
    title: string | null,
  ): Promise<Buffer> {
    switch (format) {
      case 'json':
        return Buffer.from(this.toJson(result), 'utf-8');
      case 'markdown':
        return Buffer.from(this.toMarkdown(result, title), 'utf-8');
      case 'text':
        return Buffer.from(this.toText(result, title), 'utf-8');
      case 'xlsx':
        return this.toXlsx(result, title);
    }
  }

  // --- JSON ----------------------------------------------------------------

  private toJson(result: QueryResult): string {
    const rows = result.rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const col of result.columns) out[col] = this.jsonValue(row[col]);
      return out;
    });
    return JSON.stringify(rows, null, 2);
  }

  private jsonValue(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    return value ?? null;
  }

  // --- Markdown ------------------------------------------------------------

  private toMarkdown(result: QueryResult, title: string | null): string {
    const lines: string[] = [];
    if (title) lines.push(`# ${title}`, '');
    if (result.columns.length === 0 || result.rows.length === 0) {
      lines.push('_No rows._');
      return lines.join('\n');
    }
    const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${result.columns.map(esc).join(' | ')} |`);
    lines.push(`| ${result.columns.map(() => '---').join(' | ')} |`);
    for (const row of result.rows) {
      const cells = result.columns.map((c) => esc(this.cellString(row[c])));
      lines.push(`| ${cells.join(' | ')} |`);
    }
    if (result.truncated)
      lines.push('', `_Truncated to ${result.rowCount} rows._`);
    return lines.join('\n');
  }

  // --- Plain text (aligned columns) ---------------------------------------

  private toText(result: QueryResult, title: string | null): string {
    const lines: string[] = [];
    if (title) lines.push(title, '='.repeat(title.length), '');
    if (result.columns.length === 0 || result.rows.length === 0) {
      lines.push('No rows.');
      return lines.join('\n');
    }
    const widths = result.columns.map((c) => c.length);
    const table = result.rows.map((row) =>
      result.columns.map((c, i) => {
        const s = this.cellString(row[c]);
        if (s.length > widths[i]) widths[i] = s.length;
        return s;
      }),
    );
    const pad = (s: string, w: number) => s.padEnd(w);
    lines.push(result.columns.map((c, i) => pad(c, widths[i])).join('  '));
    lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
    for (const cells of table) {
      lines.push(cells.map((s, i) => pad(s, widths[i])).join('  '));
    }
    if (result.truncated)
      lines.push('', `(truncated to ${result.rowCount} rows)`);
    return lines.join('\n');
  }

  // --- XLSX ----------------------------------------------------------------

  private async toXlsx(
    result: QueryResult,
    title: string | null,
  ): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.created = new Date(0); // deterministic; avoids embedding wall-clock time
    const ws = wb.addWorksheet((title ?? 'Report').slice(0, 31) || 'Report');
    ws.columns = result.columns.map((c) => ({
      header: c,
      key: c,
      width: Math.min(Math.max(c.length + 2, 12), 60),
    }));
    ws.getRow(1).font = { bold: true };
    for (const row of result.rows) {
      const out: Record<string, unknown> = {};
      for (const c of result.columns) out[c] = this.xlsxValue(row[c]);
      ws.addRow(out);
    }
    return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  }

  private xlsxValue(value: unknown): unknown {
    if (value == null) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'object') return JSON.stringify(value);
    // pg returns numeric/bigint columns as strings; coerce clean numbers so
    // Excel treats them as numbers (not text) without losing precision badly.
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
      const n = Number(value);
      if (Number.isFinite(n) && String(n) === value) return n;
    }
    return value;
  }

  // --- shared --------------------------------------------------------------

  private cellString(value: unknown): string {
    if (value == null) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
}
