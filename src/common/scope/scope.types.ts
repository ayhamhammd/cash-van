/**
 * The set of reps a request is allowed to touch.
 *
 * Two link shapes exist across the schema — some tables carry `rep_id`, others
 * carry `user_code` (= users.user_number of the rep's login). Both are resolved
 * together, once, so a query never has to join `reps` just to filter.
 *
 * See docs/SPEC-supervisor-scoping.md §5.
 */
export type Scope =
  | { kind: 'ALL' }
  | {
      kind: 'REPS';
      // readonly on purpose: a scope is a decision that has already been made.
      // Nothing downstream may append to it, and TypeORM's In() / :...params
      // both accept readonly arrays, so nothing has to copy it either.
      readonly repIds: readonly string[];
      readonly userCodes: readonly string[];
    };

/**
 * Sees nothing. The default for any user we cannot positively scope.
 *
 * Frozen, arrays included: this one object is handed to every caller, so a
 * stray push would widen the scope of every request in the process.
 */
export const EMPTY_SCOPE: Scope = Object.freeze({
  kind: 'REPS',
  repIds: Object.freeze<string[]>([]),
  userCodes: Object.freeze<string[]>([]),
});

/** True when the scope imposes no filtering at all (main admin). */
export function isUnscoped(scope: Scope): scope is { kind: 'ALL' } {
  return scope.kind === 'ALL';
}

/**
 * True when the scope can never match a row. Callers must short-circuit to an
 * empty result rather than building `IN ()`, which is invalid SQL and — worse —
 * a tempting place to "just skip the filter".
 */
export function isEmptyScope(scope: Scope): boolean {
  return scope.kind === 'REPS' && scope.repIds.length === 0;
}
