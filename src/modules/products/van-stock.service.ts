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

  async forRep(repId: string): Promise<VanStockRow[]> {
    await this.assertRep(repId);
    const rows = await this.stock
      .createQueryBuilder('vs')
      .innerJoin(ItemCart, 'p', 'p.id = vs.product_id')
      .select([
        'vs.product_id AS product_id',
        'vs.quantity AS quantity',
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
        snapshot_at: Date;
        sku: string;
        name_ar: string;
        reorder_qty: number;
      }>();

    return rows.map((r) => {
      const quantity = Number(r.quantity);
      const reorderQty = Number(r.reorder_qty);
      let status: VanStockRow['status'] = 'sufficient';
      if (quantity <= 0) status = 'stockout';
      else if (reorderQty > 0 && quantity <= reorderQty) status = 'borderline';
      return {
        productId: r.product_id,
        sku: r.sku,
        nameAr: r.name_ar,
        quantity,
        reorderQty,
        status,
        snapshotAt: r.snapshot_at,
      };
    });
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
