import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { VanStock } from './entities/van-stock.entity';
import { Rep } from '../reps/entities/rep.entity';
import { ItemCart } from '../items/entities/item-cart.entity';
import { VanStockLineDto } from './dto/van-stock.dto';

export interface VanStockRow {
  productId: string;
  sku: string;
  nameAr: string;
  quantity: number;
  reserved: number;
  reorderQty: number;
  status: 'sufficient' | 'borderline' | 'stockout';
  snapshotAt: Date;
}

@Injectable()
export class VanStockService {
  constructor(
    @InjectRepository(VanStock)
    private readonly stock: Repository<VanStock>,
    @InjectRepository(Rep)
    private readonly reps: Repository<Rep>,
    @InjectRepository(ItemCart)
    private readonly products: Repository<ItemCart>,
  ) {}

  /**
   * A salesman's van IS a store (rep.van_id → warehouse). The dashboard loads a
   * van by transferring stock INTO that store, so van stock is the voucher-derived
   * `item_balance` for the rep's store — the same source the dashboard shows.
   * Falls back to the legacy `van_stock` table for reps with no linked store.
   */
  async forRep(repId: string): Promise<VanStockRow[]> {
    await this.assertRep(repId);
    const store = await this.resolveVanStore(repId);
    return store ? this.forStore(store) : this.forVanStockTable(repId);
  }

  /** Resolve the rep's van store number (warehouse) — null when unlinked. */
  private async resolveVanStore(repId: string): Promise<string | null> {
    const rows: Array<{ wh_number: string }> = await this.stock.manager.query(
      `SELECT w.wh_number
         FROM reps r
         JOIN warehouses w ON w.id = r.van_id
        WHERE r.id = $1 AND r.van_id IS NOT NULL
        LIMIT 1`,
      [repId],
    );
    return rows[0]?.wh_number ?? null;
  }

  /** Voucher-derived balance for the van's store, with open-order reservations. */
  private async forStore(store: string): Promise<VanStockRow[]> {
    const rows: Array<{
      product_id: string;
      sku: string;
      name_ar: string;
      reorder_qty: number;
      quantity: number;
      reserved: number;
    }> = await this.stock.manager.query(
      `SELECT ic.id           AS product_id,
              ic.sku          AS sku,
              ic.name_ar      AS name_ar,
              ic.reorder_qty  AS reorder_qty,
              b.qty::float8   AS quantity,
              COALESCE(o.reserved, 0)::float8 AS reserved
         FROM item_balance b
         JOIN item_cart ic
           ON ic.item_number = b.item_number AND ic.deleted_at IS NULL
         LEFT JOIN (
           SELECT vt.item_number, SUM(vt.item_qty::numeric) AS reserved
             FROM voucher_transactions vt
             JOIN voucher_headers vh ON vh.voucher_number = vt.voucher_number
            WHERE vh.trans_kind = 'ORDER'
              AND vh.is_posted = true
              AND vh.is_fulfilled = false
              AND COALESCE(vt.store_number, vt.from_store_number) = $1
            GROUP BY vt.item_number
         ) o ON o.item_number = b.item_number
        WHERE b.stock_number = $1
          AND b.qty <> 0
        ORDER BY ic.name_ar ASC`,
      [store],
    );
    const now = new Date();
    return rows.map((r) => this.toRow(r, now));
  }

  /** Legacy per-rep van_stock table (reps with no linked store). */
  private async forVanStockTable(repId: string): Promise<VanStockRow[]> {
    const rows = await this.stock
      .createQueryBuilder('vs')
      .innerJoin(ItemCart, 'p', 'p.id = vs.product_id')
      .select([
        'vs.product_id AS product_id',
        'vs.quantity AS quantity',
        'vs.reserved AS reserved',
        'vs.snapshot_at AS snapshot_at',
        'p.sku AS sku',
        'p.name_ar AS name_ar',
        'p.reorder_qty AS reorder_qty',
      ])
      .where('vs.rep_id = :repId', { repId })
      .orderBy('p.name_ar', 'ASC')
      .getRawMany<{
        product_id: string;
        quantity: number;
        reserved: number;
        snapshot_at: Date;
        sku: string;
        name_ar: string;
        reorder_qty: number;
      }>();
    return rows.map((r) => this.toRow(r, r.snapshot_at));
  }

  private toRow(
    r: {
      product_id: string;
      sku: string;
      name_ar: string;
      reorder_qty: number;
      quantity: number;
      reserved: number;
    },
    snapshotAt: Date,
  ): VanStockRow {
    const quantity = Number(r.quantity);
    const reserved = Number(r.reserved);
    const available = quantity - reserved;
    const reorderQty = Number(r.reorder_qty);
    let status: VanStockRow['status'] = 'sufficient';
    if (available <= 0) status = 'stockout';
    else if (reorderQty > 0 && available <= reorderQty) status = 'borderline';
    return {
      productId: r.product_id,
      sku: r.sku,
      nameAr: r.name_ar,
      quantity,
      reserved,
      reorderQty,
      status,
      snapshotAt,
    };
  }

  /** Add quantities to the van (load from warehouse). Upserts per product. */
  async load(repId: string, items: VanStockLineDto[]): Promise<{ updated: number }> {
    await this.assertRep(repId);
    await this.assertProducts(items.map((i) => i.productId));
    return this.mutate(repId, items, +1);
  }

  /** Subtract quantities (return to warehouse). Clamps at zero. */
  async return(repId: string, items: VanStockLineDto[]): Promise<{ updated: number }> {
    await this.assertRep(repId);
    await this.assertProducts(items.map((i) => i.productId));
    return this.mutate(repId, items, -1);
  }

  private async mutate(
    repId: string,
    items: VanStockLineDto[],
    sign: 1 | -1,
  ): Promise<{ updated: number }> {
    await this.stock.manager.transaction(async (em) => {
      const repo = em.getRepository(VanStock);
      for (const item of items) {
        const existing = await repo.findOne({
          where: { repId, productId: item.productId },
        });
        const delta = sign * item.quantity;
        if (existing) {
          existing.quantity = Math.max(0, existing.quantity + delta);
          existing.snapshotAt = new Date();
          if (sign === 1) existing.loadedAt = new Date();
          await repo.save(existing);
        } else {
          await repo.save(
            repo.create({
              repId,
              productId: item.productId,
              quantity: Math.max(0, delta),
              loadedAt: sign === 1 ? new Date() : null,
              snapshotAt: new Date(),
            }),
          );
        }
      }
    });
    return { updated: items.length };
  }

  private async assertRep(repId: string): Promise<void> {
    if (!(await this.reps.exist({ where: { id: repId } }))) {
      throw new NotFoundException(`Rep ${repId} not found`);
    }
  }

  private async assertProducts(ids: string[]): Promise<void> {
    for (const id of new Set(ids)) {
      if (!(await this.products.exist({ where: { id } }))) {
        throw new NotFoundException(`Product ${id} not found`);
      }
    }
  }
}
