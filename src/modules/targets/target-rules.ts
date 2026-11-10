/**
 * The rules every target figure shares — the monthly sales target
 * (targets.service.ts) and item targets (item-targets.service.ts) both read
 * them from here, so the two cannot drift apart.
 */

/** The company's targets_include_tax setting, as SQL (true when unset). */
export const INCLUDE_TAX_SQL = `COALESCE((SELECT s.targets_include_tax FROM app_settings s ORDER BY s.id LIMIT 1), true)`;

/**
 * A voucher that counts toward a month: posted, dated in [$1, $2). Its rep is
 * the one whose LOGIN is the voucher's user_code (users.user_number), joined as
 * reps → users or, from the voucher side, VOUCHER_REP_JOIN.
 */
export const POSTED_IN_PERIOD = `h.is_posted = true AND h.in_date >= $1::date AND h.in_date < $2::date`;
export const VOUCHER_REP_JOIN = `JOIN users u ON u.user_number = h.user_code JOIN reps r ON r.user_id = u.id`;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** [monthStart, nextMonthStart) as YYYY-MM-DD strings for the SQL date range. */
export function periodBounds(year: number, month: number): [string, string] {
  const start = `${year}-${pad(month)}-01`;
  const end = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  return [start, end];
}
