import { REPORT_FORMATS } from '../agent.types';
import type { LlmToolDef } from '../llm/llm.types';

/**
 * Provider-neutral tool definitions (JSON-Schema parameters). Each LLM provider
 * adapts these to its native tool/function-declaration format.
 */
export const AGENT_TOOL_DEFS: LlmToolDef[] = [
  {
    name: 'get_schema',
    description:
      'Return the database schema (tables and their columns with types). ' +
      'Call this first, before writing any SQL, so column names and types are correct.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'run_sql',
    description:
      'Run a single read-only PostgreSQL SELECT and return a small preview of ' +
      'the rows plus the row count. Use this to inspect data and verify a query ' +
      'before producing a report, or to answer a quick question. Only SELECT is ' +
      'allowed; any other statement is rejected.',
    parameters: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description:
            'A single SELECT statement. Use explicit column lists, cast money/qty ' +
            "text columns with ::numeric, and filter deleted_at IS NULL for current data.",
        },
      },
      required: ['sql'],
    },
  },
  {
    name: 'generate_report',
    description:
      'Run a read-only SELECT and render the full result set into a downloadable ' +
      'report file in the requested format. Use this only when the user wants a ' +
      'deliverable file. For a quick answer, just reply in text instead. ' +
      'Supported formats: ' +
      REPORT_FORMATS.join(', ') +
      '. If the user asks for any other format (e.g. csv, pdf, docx), do NOT call ' +
      'this tool — tell them in text that the format is not supported yet.',
    parameters: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'The single SELECT whose result becomes the report.',
        },
        format: {
          type: 'string',
          enum: [...REPORT_FORMATS],
          description: 'Output format for the report file.',
        },
        title: {
          type: 'string',
          description: 'Short human-readable report title (used in the file).',
        },
      },
      required: ['sql', 'format'],
    },
  },
];
