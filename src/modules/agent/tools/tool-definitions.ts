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
      '. Prefer xlsx when the user will work with the numbers, and pdf when they ' +
      'will read, print or send it. Arabic renders correctly in pdf. ' +
      'If the user asks for a format not in that list (e.g. csv, docx), do NOT ' +
      'call this tool — tell them in text that the format is not supported yet.',
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
  {
    name: 'run_checks',
    description:
      'Run the reviewed audit battery: a fixed set of read-only SQL checks for ' +
      'the things that go wrong in cash-van operations (vouchers with no ' +
      'payment, customers over their credit limit, sales made away from the ' +
      "customer's location, undeposited collections, negative van stock, " +
      'documents that never reached the ERP). Returns each check with how many ' +
      'rows it found and a small sample. Call this FIRST when asked what looks ' +
      'wrong. You do not write these queries and cannot add to them; your job ' +
      'is to explain and rank what they returned.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_geo',
    description:
      'Customers with their coordinates, assigned salesman, outstanding debt, ' +
      'last visit, last sale and sale count over the past 90 days — in one ' +
      'call. Use this for anything about location, proximity, route coverage ' +
      'or which customers have gone quiet, instead of assembling the same ' +
      'joins by hand. Ordered least-recently-sold-to first.',
    parameters: {
      type: 'object',
      properties: {
        repId: {
          type: 'string',
          description:
            "Optional rep UUID to restrict to one salesman's customers.",
        },
      },
    },
  },
  {
    name: 'run_python',
    description:
      'Run Python over a query result, for analysis SQL cannot express: ' +
      'regression, cohort and retention curves, clustering, and charts. ' +
      'pandas, numpy, matplotlib and openpyxl are available. Pass `sql` and the ' +
      'rows arrive as a JSON array at /job/data.json — read it with ' +
      "pandas.read_json('/job/data.json'). Anything the script writes into " +
      '/job/out becomes a downloadable file (charts as .png, tables as .xlsx or ' +
      '.csv). There is NO network and NO database access inside the sandbox: ' +
      'everything the script needs must come through `sql`. If the tool replies ' +
      'that it is not enabled, do not retry it — answer with SQL instead.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'The complete Python program. Print what you want to read back; ' +
            'save charts and files into /job/out.',
        },
        sql: {
          type: 'string',
          description:
            'Optional single SELECT whose rows become /job/data.json.',
        },
      },
      required: ['code'],
    },
  },
];
