import type { LlmMessage } from './llm/llm.types';

/** Report output formats the renderer supports. Anything else → the agent
 * tells the user (in text) that the format isn't supported yet. */
export type ReportFormat = 'text' | 'markdown' | 'json' | 'xlsx';

export const REPORT_FORMATS: ReportFormat[] = [
  'text',
  'markdown',
  'json',
  'xlsx',
];

/** A persisted chat turn — the provider-neutral message shape. */
export type StoredMessage = LlmMessage;

/** A single result set: ordered column names + row objects keyed by column. */
export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /** True when more rows existed than were returned (capped by row limit). */
  truncated: boolean;
}

/** Server-Sent Event payloads emitted during a chat turn. */
export type AgentEvent =
  | { type: 'text'; data: { delta: string } }
  | { type: 'tool_start'; data: { id: string; name: string; input: unknown } }
  | {
      type: 'tool_result_summary';
      data: { id: string; name: string; ok: boolean; summary: string };
    }
  | { type: 'report_ready'; data: ReportRef }
  | {
      type: 'done';
      data: { conversationId: string; reportIds: string[]; stopReason: string };
    }
  | { type: 'error'; data: { message: string } };

/** What the client needs to fetch a generated report. */
export interface ReportRef {
  reportId: string;
  title: string | null;
  format: ReportFormat;
  filename: string;
  rowCount: number;
  /** Authenticated download endpoint for the file. */
  downloadUrl: string;
}
