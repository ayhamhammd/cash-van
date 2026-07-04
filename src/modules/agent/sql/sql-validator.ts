import { Injectable } from '@nestjs/common';
import { Parser } from 'node-sql-parser';
import type { AST, Select } from 'node-sql-parser';

/** Thrown when model-generated SQL fails validation. The message is safe to
 * hand back to the model so it can correct itself. */
export class InvalidSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSqlError';
  }
}

export interface ValidatedSql {
  /** The cleaned SQL actually sent to Postgres (trailing `;` stripped, a
   * safety LIMIT appended when the query had none). */
  sql: string;
  /** Tables referenced (for logging). */
  tables: string[];
  /** True when a default LIMIT was appended. */
  limited: boolean;
}

const PARSE_OPTS = { database: 'PostgreSQL' } as const;
const MAX_SQL_LENGTH = 20_000;

/**
 * Validates that a string is a single, read-only `SELECT` before it ever
 * reaches the database. This is the primary guard; the read-only DB role and
 * read-only transaction are the backstops.
 *
 * Rejects: anything that isn't exactly one statement, anything whose top-level
 * node isn't a SELECT, and SELECTs whose CTEs hide a data-modifying statement
 * (`WITH x AS (INSERT ...) SELECT ...`) — caught via the operation-typed
 * `tableList` entries, every one of which must be a `select`.
 */
@Injectable()
export class SqlValidator {
  private readonly parser = new Parser();

  validate(rawSql: string, defaultLimit: number): ValidatedSql {
    if (typeof rawSql !== 'string' || rawSql.trim().length === 0) {
      throw new InvalidSqlError('SQL is empty.');
    }
    if (rawSql.length > MAX_SQL_LENGTH) {
      throw new InvalidSqlError(
        `SQL is too long (max ${MAX_SQL_LENGTH} characters).`,
      );
    }

    // Strip a single trailing semicolon + whitespace; a SELECT needs no more.
    const sql = rawSql.trim().replace(/;\s*$/, '').trim();

    let parsed: { tableList: string[]; ast: AST | AST[] };
    try {
      parsed = this.parser.parse(sql, PARSE_OPTS) as {
        tableList: string[];
        ast: AST | AST[];
      };
    } catch {
      // astify throwing == malformed or multi-statement → reject.
      throw new InvalidSqlError(
        'Could not parse SQL. Provide a single, valid SELECT statement.',
      );
    }

    const statements = Array.isArray(parsed.ast) ? parsed.ast : [parsed.ast];
    if (statements.length !== 1) {
      throw new InvalidSqlError('Only one statement is allowed.');
    }

    const stmt = statements[0];
    if (stmt.type?.toLowerCase() !== 'select') {
      throw new InvalidSqlError(
        `Only SELECT statements are allowed (got "${stmt.type}").`,
      );
    }

    // Reject data-modifying CTEs: every tableList entry is "<op>::<db>::<table>".
    const offending = (parsed.tableList ?? []).filter(
      (entry) => !entry.toLowerCase().startsWith('select::'),
    );
    if (offending.length > 0) {
      throw new InvalidSqlError(
        'Only read operations are allowed; data-modifying statements (including in CTEs) are rejected.',
      );
    }

    const select = stmt as Select;
    const hasLimit = select.limit != null && !this.isEmptyLimit(select.limit);
    const finalSql = hasLimit ? sql : `${sql}\nLIMIT ${defaultLimit}`;

    const tables = (parsed.tableList ?? []).map((entry) => {
      const parts = entry.split('::');
      return parts[parts.length - 1];
    });

    return { sql: finalSql, tables, limited: !hasLimit };
  }

  /** node-sql-parser sometimes yields a limit node with an empty value array. */
  private isEmptyLimit(limit: Select['limit']): boolean {
    const value = (limit as { value?: unknown[] } | null)?.value;
    return Array.isArray(value) && value.length === 0;
  }
}
