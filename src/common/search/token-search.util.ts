import { Brackets, WhereExpressionBuilder } from 'typeorm';

/**
 * The one search strategy, used by every list endpoint.
 *
 * Splits the query into whitespace-separated tokens and requires that EVERY
 * token appears — as a case-insensitive substring — in AT LEAST ONE of the
 * given fields. Word order does not matter, and a token may match a different
 * field than its neighbour.
 *
 *   "abu market"  →  (…ILIKE '%abu%') AND (…ILIKE '%market%')
 *
 * So "Abu Rayash Market" matches, but "Abu Bakr Bakery" (no "market") does not
 * — more words narrow the result rather than widening it. Numbers ride the same
 * path: "77" is just another substring token, so it finds "1772".
 *
 * `fields` are raw column references in the caller's query (e.g. 'c.name_ar').
 * A blank/whitespace query adds nothing, leaving the list unfiltered.
 *
 * @returns the number of tokens applied (0 when the query was empty).
 */
export function applyTokenSearch(
  qb: WhereExpressionBuilder,
  q: string | null | undefined,
  fields: string[],
): number {
  const tokens = (q ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || fields.length === 0) return 0;

  tokens.forEach((tok, i) => {
    const key = `st_${i}`;
    const value = `%${tok}%`;
    qb.andWhere(
      new Brackets((b) => {
        fields.forEach((f, j) => {
          const cond = `${f} ILIKE :${key}`;
          if (j === 0) b.where(cond, { [key]: value });
          else b.orWhere(cond, { [key]: value });
        });
      }),
    );
  });
  return tokens.length;
}
