import { NotFoundException } from '@nestjs/common';
import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import { Scope } from './scope.types';

/**
 * Query-layer helpers for applying a resolved {@link Scope}.
 *
 * Endpoint-by-endpoint filtering is the failure mode this exists to avoid: one
 * missed list and a supervisor sees another segment while the UI insists they
 * cannot. Everything funnels through these four functions so the filter is
 * written once and reviewed once.
 *
 * See docs/SPEC-supervisor-scoping.md §6.2.
 */

/** Param names must not collide when a builder is scoped more than once. */
let paramSeq = 0;
function nextParam(prefix: string): string {
  paramSeq = (paramSeq + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}${paramSeq}`;
}

function applyList<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  column: string,
  values: readonly string[],
  prefix: string,
): SelectQueryBuilder<T> {
  // Empty scope: match nothing, explicitly. `IN ()` is invalid SQL, and the
  // tempting alternative — skipping the filter — is the leak itself.
  if (values.length === 0) return qb.andWhere('1 = 0');

  const p = nextParam(prefix);
  return qb.andWhere(`${column} IN (:...${p})`, { [p]: values });
}

/**
 * Restrict a query to the scope's reps, by a `rep_id`-shaped column.
 *
 *   applyRepScope(qb, scope, 'c.rep_id')
 */
export function applyRepScope<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  scope: Scope,
  column: string,
): SelectQueryBuilder<T> {
  if (scope.kind === 'ALL') return qb;
  return applyList(qb, column, scope.repIds, 'scopeRepIds');
}

/**
 * Restrict a query to the scope's reps, by a `user_code`-shaped column — the
 * salesman's `users.user_number`, which is what vouchers and invoices carry.
 *
 * A scope with reps but no user codes (every assigned rep lacks a login) still
 * matches nothing here, which is correct: there are no rows to see.
 */
export function applyUserCodeScope<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  scope: Scope,
  column: string,
): SelectQueryBuilder<T> {
  if (scope.kind === 'ALL') return qb;
  return applyList(qb, column, scope.userCodes, 'scopeUserCodes');
}

/** True when this rep is visible under the scope. */
export function repInScope(scope: Scope, repId: string | null | undefined): boolean {
  if (scope.kind === 'ALL') return true;
  return Boolean(repId) && scope.repIds.includes(repId as string);
}

/** True when this salesman code is visible under the scope. */
export function userCodeInScope(
  scope: Scope,
  userCode: string | null | undefined,
): boolean {
  if (scope.kind === 'ALL') return true;
  return Boolean(userCode) && scope.userCodes.includes(userCode as string);
}

/**
 * Gate a single record — read or write — on the scope.
 *
 * Throws NotFound, never Forbidden: a 403 confirms the record exists, which
 * hands an out-of-scope caller the one bit they should not get. Same reasoning
 * applies to writes, so approve/edit/delete use this too.
 */
export function assertRepInScope(
  scope: Scope,
  repId: string | null | undefined,
  what = 'Record',
): void {
  if (!repInScope(scope, repId)) {
    throw new NotFoundException(`${what} not found`);
  }
}

/** As {@link assertRepInScope}, for `user_code`-linked records. */
export function assertUserCodeInScope(
  scope: Scope,
  userCode: string | null | undefined,
  what = 'Record',
): void {
  if (!userCodeInScope(scope, userCode)) {
    throw new NotFoundException(`${what} not found`);
  }
}
