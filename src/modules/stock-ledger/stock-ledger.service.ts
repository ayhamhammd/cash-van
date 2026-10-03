import { Injectable, Logger } from '@nestjs/common';
import { negativeValue } from '../warehouses/negative-stock';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** One movement on a stock card, newest first, with the balance after it. */
export interface StockCardRow {
  seq: number;
  /** When the ledger recorded the movement. */
  at: string;
  /**
   * The document's own date — when the goods actually moved. An offline sale
   * uploaded hours later is recorded then, but it was sold at this time.
   */
  documentAt: string | null;
  /** Base pieces ×1000, signed. */
  qtyMilli: number;
  balanceMilli: number;
  reason: string;
  voucherNumber: string | null;
  voucherId: string | null;
  transKind: string | null;
  userCode: string | null;
}

export interface StockCard {
  store: string;
  itemNumber: string;
  stockUnitCode: string;
  /** What the store holds now, ×1000 — the stored balance. */
  balanceMilli: number;
  rows: StockCardRow[];
  /** Pass as `beforeSeq` for the next, older page; null when this was the first movement. */
  nextBeforeSeq: number | null;
}

export interface LedgerDifference {
  storeNumber: string;
  itemNumber: string;
  stockUnitCode: string;
  ledgerMilli: number;
  replayMilli: number;
}

/**
 * Reads over the stock ledger (docs/SPEC-single-stock-model.md).
 *
 * Deliberately has no write: the ledger changes only through the database
 * function `stock_apply()`, called by the voucher triggers, so that no code path
 * — this one included — can move stock without the balance following.
 */
@Injectable()
export class StockLedgerService {
  private readonly logger = new Logger(StockLedgerService.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /**
   * The stock card (كرت الصنف) of one pool in one store: every movement that made
   * its balance, newest first, each with the balance it left behind.
   */
  async card(q: {
    store: string;
    itemNumber: string;
    stockUnitCode?: string;
    limit?: number;
    beforeSeq?: number;
  }): Promise<StockCard> {
    const pool = q.stockUnitCode ?? '';
    const limit = q.limit ?? 100;
    // The running balance is a window over the pool's movements up to each row.
    // Paging backwards with `seq < beforeSeq` keeps it right: every row's balance
    // only ever depends on the rows older than it.
    const rows: Array<{
      seq: string;
      created_at: Date;
      qty_milli: string;
      balance_milli: string;
      reason: string;
      voucher_number: string | null;
      voucher_id: string | null;
      document_at: Date | null;
      trans_kind: string | null;
      user_code: string | null;
    }> = await this.ds.query(
      `SELECT * FROM (
         SELECT m.seq, m.created_at, m.qty_milli, m.reason, m.voucher_number,
                vh.id AS voucher_id, vh.trans_kind, vh.user_code, vh.in_date AS document_at,
                SUM(m.qty_milli) OVER (ORDER BY m.seq) AS balance_milli
           FROM stock_movements m
           LEFT JOIN voucher_headers vh ON vh.voucher_number = m.voucher_number
          WHERE m.store_number = $1 AND m.item_number = $2 AND m.stock_unit_code = $3
            AND ($5::bigint IS NULL OR m.seq < $5::bigint)
       ) t
       ORDER BY t.seq DESC
       LIMIT $4`,
      [q.store, q.itemNumber, pool, limit, q.beforeSeq ?? null],
    );
    const [bal]: Array<{ qty_milli: string }> = await this.ds.query(
      `SELECT qty_milli FROM stock_balance
        WHERE store_number = $1 AND item_number = $2 AND stock_unit_code = $3`,
      [q.store, q.itemNumber, pool],
    );
    const mapped = rows.map((r) => ({
      seq: Number(r.seq),
      at: new Date(r.created_at).toISOString(),
      documentAt: r.document_at ? new Date(r.document_at).toISOString() : null,
      qtyMilli: Number(r.qty_milli),
      balanceMilli: Number(r.balance_milli),
      reason: r.reason,
      voucherNumber: r.voucher_number,
      voucherId: r.voucher_id,
      transKind: r.trans_kind,
      userCode: r.user_code,
    }));
    return {
      store: q.store,
      itemNumber: q.itemNumber,
      stockUnitCode: pool,
      balanceMilli: Number(bal?.qty_milli ?? 0),
      rows: mapped,
      nextBeforeSeq: mapped.length === limit ? mapped[mapped.length - 1].seq : null,
    };
  }

  /**
   * Every pool where the stored balance differs from a full replay of the posted
   * vouchers — the old `item_balance` definition, kept as `item_balance_replay`.
   *
   * By construction this is empty: the triggers apply exactly what the replay
   * sums. It exists to catch what construction cannot — a writer that bypasses
   * the triggers (a TRUNCATE, a trigger disabled for a bulk load, a restore of one
   * table without the other). Expensive (it replays all history); run it nightly
   * and on demand, never in a request path.
   */
  /**
   * Every pool sitting below zero, by store, with what it is worth.
   *
   * A van allowed to go negative WILL go negative, and nobody looks at a number
   * they are not shown: the 77 client reached -46 on one item and it was only
   * found by reading the balances straight out of the database. So the balances
   * this permission produces are reported rather than left to be discovered.
   *
   * The value is the figure finance needs — a van twelve short of something
   * costing 4.000 is carrying a 48.000 hole in the inventory account, and the
   * quantity alone does not say that. An item with no cost recorded contributes
   * nothing rather than -0.
   *
   * Reads the ledger, not van_stock: the ledger is what the rest of the system
   * answers "how much is there?" with, so a negative that does not appear here
   * is not one anybody is acting on.
   */
  async negativePools(): Promise<{
    checkedAt: string;
    pools: Array<{
      storeNumber: string;
      storeName: string | null;
      itemNumber: string;
      itemName: string | null;
      stockUnitCode: string;
      qty: number;
      unitCostFils: number | null;
      valueFils: number;
    }>;
    totalValueFils: number;
  }> {
    const rows: Array<{
      store_number: string;
      store_name: string | null;
      item_number: string;
      item_name: string | null;
      stock_unit_code: string;
      qty: string;
      cost: number | null;
    }> = await this.ds.query(
      `SELECT b.stock_number    AS store_number,
              w.wh_name         AS store_name,
              b.item_number     AS item_number,
              b.item_name       AS item_name,
              b.stock_unit_code AS stock_unit_code,
              b.qty             AS qty,
              ic.cost           AS cost
         FROM item_balance b
         LEFT JOIN warehouses w ON w.wh_number = b.stock_number
         LEFT JOIN item_cart  ic ON ic.item_number = b.item_number
        WHERE b.qty < 0
        ORDER BY (b.qty * COALESCE(ic.cost, 0)) ASC, b.stock_number, b.item_number`,
    );

    const pools = rows.map((r) => {
      const qty = Number(r.qty) || 0;
      const unitCostFils = r.cost ?? null;
      return {
        storeNumber: r.store_number,
        storeName: r.store_name,
        itemNumber: r.item_number,
        itemName: r.item_name,
        stockUnitCode: r.stock_unit_code,
        qty,
        unitCostFils,
        valueFils: negativeValue(qty, unitCostFils ?? 0),
      };
    });

    return {
      checkedAt: new Date().toISOString(),
      pools,
      totalValueFils: pools.reduce((sum, p) => sum + p.valueFils, 0),
    };
  }

  async verify(): Promise<{ checkedAt: string; differences: LedgerDifference[] }> {
    const rows: Array<{
      store_number: string;
      item_number: string;
      stock_unit_code: string;
      ledger_milli: string;
      replay_milli: string;
    }> = await this.ds.query(
      `SELECT COALESCE(b.store_number, r.stock_number)       AS store_number,
              COALESCE(b.item_number, r.item_number)         AS item_number,
              COALESCE(b.stock_unit_code, r.stock_unit_code) AS stock_unit_code,
              COALESCE(b.qty_milli, 0)                       AS ledger_milli,
              COALESCE(r.milli, 0)                           AS replay_milli
         FROM stock_balance b
         FULL OUTER JOIN (
           SELECT stock_number, item_number, stock_unit_code, ROUND(qty * 1000)::bigint AS milli
             FROM item_balance_replay
            WHERE stock_number IS NOT NULL
         ) r
           ON r.stock_number = b.store_number
          AND r.item_number = b.item_number
          AND r.stock_unit_code = b.stock_unit_code
        WHERE COALESCE(b.qty_milli, 0) <> COALESCE(r.milli, 0)
        ORDER BY 1, 2, 3`,
    );
    return {
      checkedAt: new Date().toISOString(),
      differences: rows.map((r) => ({
        storeNumber: r.store_number,
        itemNumber: r.item_number,
        stockUnitCode: r.stock_unit_code,
        ledgerMilli: Number(r.ledger_milli),
        replayMilli: Number(r.replay_milli),
      })),
    };
  }

  /** Nightly, after the 02:00 heavy sync and its reconciliation have settled. */
  @Cron('30 3 * * *', { name: 'stock-ledger-verify' })
  async nightlyVerify(): Promise<void> {
    try {
      const { differences } = await this.verify();
      if (differences.length === 0) {
        this.logger.log('stock ledger verified: every balance equals its replay');
        return;
      }
      this.logger.error(
        `stock ledger differs from the voucher replay in ${differences.length} pool(s) — ` +
          'something wrote vouchers around the triggers. First few: ' +
          differences
            .slice(0, 5)
            .map((d) => `${d.storeNumber}/${d.itemNumber}/${d.stockUnitCode || 'base'} ` +
              `ledger ${d.ledgerMilli / 1000} vs replay ${d.replayMilli / 1000}`)
            .join('; '),
      );
    } catch (e) {
      this.logger.warn(`stock ledger verify failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
