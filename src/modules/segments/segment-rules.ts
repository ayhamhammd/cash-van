import { BadRequestException } from '@nestjs/common';
import { Brackets, SelectQueryBuilder } from 'typeorm';

import { Customer } from '../customers/entities/customer.entity';

/**
 * Dynamic-segment rules — a whitelist-driven, fully-parameterised translation of
 * admin-authored criteria into a customer query.
 *
 * Security: a condition's column is ALWAYS looked up from FIELD_DEFS (a fixed
 * map), never taken from the request, and every value is bound as a query
 * parameter. So no part of the SQL text is ever built from user input.
 */

export type SegmentMatch = 'ALL' | 'ANY';

export type SegmentOp =
  | 'eq'
  | 'ne'
  | 'in'
  | 'not_in'
  | 'is_null'
  | 'not_null'
  | 'contains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'before'
  | 'after';

export interface SegmentCondition {
  field: string;
  op: SegmentOp;
  value?: string | number | boolean | Array<string | number>;
}

export interface SegmentRules {
  match: SegmentMatch;
  conditions: SegmentCondition[];
}

type FieldType = 'text' | 'uuid' | 'bool' | 'number' | 'date';

interface FieldDef {
  col: string;
  type: FieldType;
  /** Needs the customer_ai_profile LEFT JOIN. */
  ai?: boolean;
}

/** The ONLY columns a rule may filter on. `col` is trusted; request input never is. */
const FIELD_DEFS: Record<string, FieldDef> = {
  regionId: { col: 'c.region_id', type: 'uuid' },
  repId: { col: 'c.rep_id', type: 'uuid' },
  category: { col: 'c.category', type: 'text' },
  customerType: { col: 'c.customer_type', type: 'text' },
  city: { col: 'c.city', type: 'text' },
  source: { col: 'c.source', type: 'text' },
  creditHold: { col: 'c.credit_hold', type: 'bool' },
  isTaxExempt: { col: 'c.is_tax_exempt', type: 'bool' },
  isActive: { col: 'c.is_active', type: 'bool' },
  totalDebt: { col: 'c.total_debt', type: 'number' },
  creditLimit: { col: 'c.credit_limit', type: 'number' },
  createdAt: { col: 'c.created_at', type: 'date' },
  aiSegment: { col: 'cap.segment', type: 'text', ai: true },
  churnRisk: { col: 'cap.churn_risk_label', type: 'text', ai: true },
};

const OPS_BY_TYPE: Record<FieldType, SegmentOp[]> = {
  text: ['eq', 'ne', 'in', 'not_in', 'is_null', 'not_null', 'contains'],
  uuid: ['eq', 'ne', 'in', 'not_in', 'is_null', 'not_null'],
  bool: ['eq'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'],
  date: ['before', 'after'],
};

const NO_VALUE_OPS: SegmentOp[] = ['is_null', 'not_null'];
const ARRAY_OPS: SegmentOp[] = ['in', 'not_in'];

const MAX_CONDITIONS = 20;
const MAX_IN_VALUES = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ISO date (YYYY-MM-DD) optionally with a time part — the shape the app sends. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

/** The whitelist, exposed so the API/UI can render the available fields + ops. */
export const SEGMENT_RULE_FIELDS = Object.entries(FIELD_DEFS).map(([field, d]) => ({
  field,
  type: d.type,
  ops: OPS_BY_TYPE[d.type],
}));

/** Validate + normalise raw JSON into SegmentRules, or throw BadRequestException. */
export function validateRules(raw: unknown): SegmentRules {
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestException('rules must be an object');
  }
  const r = raw as { match?: unknown; conditions?: unknown };
  const match: SegmentMatch = r.match === 'ANY' ? 'ANY' : 'ALL';
  if (!Array.isArray(r.conditions)) {
    throw new BadRequestException('rules.conditions must be an array');
  }
  if (r.conditions.length > MAX_CONDITIONS) {
    throw new BadRequestException(`too many conditions (max ${MAX_CONDITIONS})`);
  }
  const conditions = r.conditions.map((c, i) => validateCondition(c, i));
  return { match, conditions };
}

function validateCondition(raw: unknown, i: number): SegmentCondition {
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestException(`condition ${i} must be an object`);
  }
  const c = raw as { field?: unknown; op?: unknown; value?: unknown };
  if (typeof c.field !== 'string' || !(c.field in FIELD_DEFS)) {
    throw new BadRequestException(`condition ${i}: unknown field "${String(c.field)}"`);
  }
  const def = FIELD_DEFS[c.field];
  const op = c.op as SegmentOp;
  if (!OPS_BY_TYPE[def.type].includes(op)) {
    throw new BadRequestException(
      `condition ${i}: operator "${String(c.op)}" not allowed for ${c.field}`,
    );
  }

  if (NO_VALUE_OPS.includes(op)) {
    return { field: c.field, op };
  }

  if (ARRAY_OPS.includes(op)) {
    if (!Array.isArray(c.value) || c.value.length === 0) {
      throw new BadRequestException(`condition ${i}: "${op}" needs a non-empty array value`);
    }
    if (c.value.length > MAX_IN_VALUES) {
      throw new BadRequestException(`condition ${i}: too many values (max ${MAX_IN_VALUES})`);
    }
    // Array ops are whitelisted only for text/uuid/number, never bool, so every
    // coerced element is a string or number.
    const arr = c.value.map(
      (v) => coerceScalar(v, def.type, i) as string | number,
    );
    return { field: c.field, op, value: arr };
  }

  if (c.value === undefined || c.value === null) {
    throw new BadRequestException(`condition ${i}: a value is required for "${op}"`);
  }
  return { field: c.field, op, value: coerceScalar(c.value, def.type, i) };
}

function coerceScalar(v: unknown, type: FieldType, i: number): string | number | boolean {
  switch (type) {
    case 'bool':
      if (typeof v !== 'boolean') {
        throw new BadRequestException(`condition ${i}: value must be a boolean`);
      }
      return v;
    case 'number': {
      // Reject an empty string up front — Number('') is 0, which would silently
      // become a real (wrong) threshold instead of a caught mistake.
      if (typeof v === 'string' && v.trim() === '') {
        throw new BadRequestException(`condition ${i}: value must be a number`);
      }
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) {
        throw new BadRequestException(`condition ${i}: value must be a number`);
      }
      return n;
    }
    case 'uuid': {
      const s = typeof v === 'string' ? v : String(v);
      if (!UUID_RE.test(s)) {
        throw new BadRequestException(`condition ${i}: value must be a valid id (uuid)`);
      }
      return s;
    }
    case 'date': {
      const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
      // Must be an ISO date the DB can parse — an empty/invalid string would
      // otherwise be bound straight into the query and blow up the refresh.
      if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) {
        throw new BadRequestException(
          `condition ${i}: value must be a date (YYYY-MM-DD)`,
        );
      }
      return s;
    }
    default:
      // text.
      if (typeof v !== 'string' && typeof v !== 'number') {
        throw new BadRequestException(`condition ${i}: value must be a string`);
      }
      return String(v);
  }
}

/** Does any condition reference an AI-profile column (so the join is needed)? */
export function rulesNeedAiJoin(rules: SegmentRules): boolean {
  return rules.conditions.some((c) => FIELD_DEFS[c.field]?.ai);
}

/**
 * Apply the rules to a customer query builder that already selects `c`. Adds a
 * single bracketed group so it ANDs cleanly with any base predicate (deleted_at).
 */
export function applyRules(
  qb: SelectQueryBuilder<Customer>,
  rules: SegmentRules,
): void {
  // A dynamic segment with no conditions targets NOBODY — never the whole table.
  if (rules.conditions.length === 0) {
    qb.andWhere('1 = 0');
    return;
  }
  qb.andWhere(
    new Brackets((w) => {
      rules.conditions.forEach((cond, i) => {
        const { sql, params } = compileCondition(cond, i);
        if (i === 0) w.where(sql, params);
        else if (rules.match === 'ANY') w.orWhere(sql, params);
        else w.andWhere(sql, params);
      });
    }),
  );
}

function compileCondition(
  cond: SegmentCondition,
  i: number,
): { sql: string; params: Record<string, unknown> } {
  const col = FIELD_DEFS[cond.field].col; // trusted, from the whitelist
  const p = `srp${i}`;
  switch (cond.op) {
    case 'eq':
      return { sql: `${col} = :${p}`, params: { [p]: cond.value } };
    case 'ne':
      return { sql: `${col} <> :${p}`, params: { [p]: cond.value } };
    case 'in':
      return { sql: `${col} IN (:...${p})`, params: { [p]: cond.value } };
    case 'not_in':
      return { sql: `${col} NOT IN (:...${p})`, params: { [p]: cond.value } };
    case 'is_null':
      return { sql: `${col} IS NULL`, params: {} };
    case 'not_null':
      return { sql: `${col} IS NOT NULL`, params: {} };
    case 'contains':
      return { sql: `${col} ILIKE :${p}`, params: { [p]: `%${String(cond.value)}%` } };
    case 'gt':
      return { sql: `${col} > :${p}`, params: { [p]: cond.value } };
    case 'gte':
      return { sql: `${col} >= :${p}`, params: { [p]: cond.value } };
    case 'lt':
      return { sql: `${col} < :${p}`, params: { [p]: cond.value } };
    case 'lte':
      return { sql: `${col} <= :${p}`, params: { [p]: cond.value } };
    case 'before':
      return { sql: `${col} < :${p}`, params: { [p]: cond.value } };
    case 'after':
      return { sql: `${col} > :${p}`, params: { [p]: cond.value } };
  }
}
