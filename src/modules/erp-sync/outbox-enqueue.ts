import type { EntityManager } from 'typeorm';

import type { ErpOutboxKind } from './entities/erp-outbox.entity';

/**
 * cash-van voucher kind → ERP outbox kind.
 *
 * Lives here rather than in `ErpSyncService` so `VouchersService` can read it.
 * `ErpSyncModule` imports `VouchersModule`, so the reverse import would be a
 * cycle — the same constraint already noted at `vouchers.service.ts:932`. A
 * plain const file with no Nest dependencies is importable from both.
 */
export const OUTBOX_KIND_BY_TRANS: Record<string, ErpOutboxKind | undefined> = {
  SALE: 'SALE_INVOICE',
  RETURN: 'SALES_RETURN',
  ORDER: 'SALES_ORDER',
  IN: 'STOCK_ADJUSTMENT',
  OUT: 'STOCK_ADJUSTMENT',
  TRANSFER: 'STOCK_TRANSFER',
};

/**
 * Vouchers mirrored IN from the ERP carry this prefix. Pushing one back would
 * be a loop: the ERP would receive its own invoice as a new one.
 */
export const ERP_MIRROR_PREFIX = 'ERP-';

/** Should this posted voucher be queued for the ERP at all? */
export function outboxKindForVoucher(
  transKind: string,
  voucherNumber: string,
): ErpOutboxKind | null {
  if (voucherNumber.startsWith(ERP_MIRROR_PREFIX)) return null;
  return OUTBOX_KIND_BY_TRANS[transKind] ?? null;
}

/**
 * Queue a document for the ERP **inside the caller's transaction**.
 *
 * This is the transactional-outbox primitive. The row commits with the document
 * or not at all, which is the whole point: the enqueue used to happen after the
 * commit, through an in-process event, so a crash, a redeploy, or a throw in any
 * of the four awaits between the two left a posted sale that was never queued —
 * and nothing anywhere looked for one.
 *
 * A free function rather than a service method because `VouchersService` cannot
 * inject `ErpOutboxService` without a module cycle (see OUTBOX_KIND_BY_TRANS).
 * It needs no DI: one statement against the caller's EntityManager.
 *
 * **Throws.** Callers inside a document transaction must let it propagate — a
 * sale that cannot be queued for the ERP has not fully happened. The
 * best-effort callers that are not inside a document transaction catch it
 * themselves.
 *
 * Semantics match the original `ErpOutboxService.enqueue`: an existing row that
 * is neither `failed` nor `dead_letter` is left alone; one that is gets revived.
 * `attempts` is deliberately NOT reset, so a revived dead letter gets one more
 * try rather than an unbounded supply of them.
 */
export async function enqueueOutboxWithin(
  em: EntityManager,
  kind: ErpOutboxKind,
  ref: string,
): Promise<void> {
  await em.query(
    `INSERT INTO erp_outbox (kind, ref, status, attempts, next_attempt_at)
     VALUES ($1, $2, 'pending', 0, now())
     ON CONFLICT (kind, ref) DO UPDATE
        SET status = CASE
              WHEN erp_outbox.status IN ('failed', 'dead_letter') THEN 'pending'
              ELSE erp_outbox.status END,
            next_attempt_at = CASE
              WHEN erp_outbox.status IN ('failed', 'dead_letter') THEN now()
              ELSE erp_outbox.next_attempt_at END,
            updated_at = now()`,
    [kind, ref],
  );
}
