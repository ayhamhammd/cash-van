/**
 * What cash-van has done to customers' debt that the ERP does not know about yet.
 *
 * `customers.total_debt` has two writers. cash-van moves it the moment a
 * document lands — a receipt lowers it (CollectionsService.applyCollectionToDebt),
 * a credit sale raises it and a return lowers it
 * (VouchersService.applyCreditVoucherToDebt). The ERP mirror then REPLACES it with
 * the ERP's figure: every pull interval from the AR aging, and every time anyone
 * opens a customer's statement.
 *
 * Those documents reach the ERP through the outbox, so for a while — the drain
 * interval at best, until someone fixes it when the push fails (an undated
 * cheque, a refused sale) — the ERP's figure is missing them. Writing it over
 * the column threw away a receipt that had already been counted. A salesman who
 * collected a shop's whole debt saw the debt come back on the next refresh, and
 * the credit guard on the handset refused the very next credit sale.
 *
 * So the mirror writes the ERP's figure PLUS this: every document that has moved
 * the column and is not yet posted to the ERP. Once the ERP posts one it drops
 * out here and is counted by the ERP instead — never by both.
 *
 * Bounded in time, on purpose. Old history that was never pushed (data from
 * before the ERP link, documents the office re-keyed by hand) must not be added
 * back forever:
 *  - a document with an outbox row that is not posted counts for
 *    {@link UNPOSTED_WINDOW_DAYS} days — long enough for the office to fix a
 *    failed push;
 *  - one with no outbox row yet counts for {@link UNQUEUED_GRACE_HOURS} hours —
 *    the moment between landing and being queued (the sweep queues stragglers).
 *
 * Positive = the customer owes more than the ERP says; negative = less. JOD major.
 */
export const UNPOSTED_WINDOW_DAYS = 30;
export const UNQUEUED_GRACE_HOURS = 24;

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

export async function unpostedDebtByCustomer(
  db: Queryable,
  customerIds?: string[],
): Promise<Map<string, number>> {
  const onlySome = customerIds !== undefined;
  if (onlySome && customerIds.length === 0) return new Map();

  const rows = (await db.query(
    `WITH receipts AS (
       -- Collections lower the debt when CONFIRMED (amount is in fils). A pending
       -- one has not moved it yet; a bounced one never brought the money.
       SELECT c.customer_id::text AS customer_id, -(c.amount::numeric / 1000) AS amount
         FROM collections c
         LEFT JOIN erp_outbox o ON o.kind = 'PAYMENT' AND o.ref = c.id::text
        WHERE c.status IN ('confirmed', 'deposited')
          -- Mirrored in FROM the ERP: the ERP has it already.
          AND NOT EXISTS (SELECT 1 FROM erp_id_map m WHERE m.entity = 'receipt' AND m.local_id = c.id::text)
          AND (   (o.id IS NOT NULL AND o.status <> 'posted'
                   AND c.created_at > now() - make_interval(days => $1))
               OR (o.id IS NULL AND c.created_at > now() - make_interval(hours => $2)))
          AND ($3::boolean = false OR c.customer_id::text = ANY($4::text[]))
     ),
     vouchers AS (
       -- Credit sales raise it, returns lower it, by their CREDIT payment rows —
       -- exactly what applyCreditVoucherToDebt applied.
       SELECT cu.id::text AS customer_id,
              CASE WHEN h.trans_kind = 'RETURN' THEN -1 ELSE 1 END * p.amount::numeric AS amount
         FROM voucher_headers h
         JOIN customers cu ON cu.customer_number = h.customer_number
         JOIN payments p ON p.voucher_number = h.voucher_number AND p.payment_type = 'CREDIT'
         LEFT JOIN erp_outbox o
                ON o.ref = h.voucher_number
               AND o.kind = CASE WHEN h.trans_kind = 'RETURN' THEN 'SALES_RETURN' ELSE 'SALE_INVOICE' END
        WHERE h.trans_kind IN ('SALE', 'RETURN')
          -- An invoice the ERP raised itself (an ORDER it invoiced): it has it.
          AND h.voucher_number NOT LIKE 'ERP-%'
          AND (   (o.id IS NOT NULL AND o.status <> 'posted'
                   AND h.in_date > now() - make_interval(days => $1))
               OR (o.id IS NULL AND h.in_date > now() - make_interval(hours => $2)))
          AND ($3::boolean = false OR cu.id::text = ANY($4::text[]))
     )
     SELECT customer_id, SUM(amount)::float8 AS amount
       FROM (SELECT * FROM receipts UNION ALL SELECT * FROM vouchers) x
      GROUP BY customer_id`,
    [UNPOSTED_WINDOW_DAYS, UNQUEUED_GRACE_HOURS, onlySome, customerIds ?? []],
  )) as Array<{ customer_id: string; amount: number | string }>;

  const out = new Map<string, number>();
  for (const r of rows) {
    const n = Number(r.amount);
    if (Number.isFinite(n) && Math.abs(n) >= 0.0005) out.set(r.customer_id, n);
  }
  return out;
}

/** The ERP's figure for a customer, with what the ERP has not posted yet put back. */
export function withUnposted(erpBalance: number, unposted: number | undefined): string {
  return (erpBalance + (unposted ?? 0)).toFixed(3); // fils: the JOD has three decimals
}
