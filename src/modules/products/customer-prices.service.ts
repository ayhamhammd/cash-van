import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { ItemCart } from '../items/entities/item-cart.entity';
import { CustomerPrice } from './entities/customer-price.entity';

/** One customer's contract/list price for a product (unit). */
export interface CustomerPriceRow {
  id: string;
  customerId: string;
  customerNumber: string;
  itemId: string | null;
  itemNumber: string | null;
  productName: string | null;
  barcode: string | null;
  unitPrice: number; // fils
  priceSource: string | null;
  origin: string; // 'erp' (mirrored) | 'local' (dashboard-authored)
  allowManualPriceEdit: boolean;
  erpPriceListName: string | null;
}

/** Create/update a dashboard-authored (local) customer price. */
export interface UpsertCustomerPriceInput {
  customerId: string;
  itemId: string;
  unitPrice: number; // fils
}

@Injectable()
export class CustomerPricesService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(CustomerPrice) private readonly prices: Repository<CustomerPrice>,
    @InjectRepository(ItemCart) private readonly items: Repository<ItemCart>,
  ) {}

  /**
   * Customer contract prices (optionally for one customer), offset-paginated.
   * Union of ERP-mirrored rows and dashboard-authored ('local') overrides;
   * consumed by the mobile app (offline cache) and the dashboard customer profile.
   */
  async list(opts: {
    customerId?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: CustomerPriceRow[]; total: number }> {
    const params: Array<string | number> = [];
    const conds: string[] = ['cp.deleted_at IS NULL'];
    if (opts.customerId) {
      params.push(opts.customerId);
      conds.push(`cp.customer_id = $${params.length}`);
    }
    const where = conds.join(' AND ');

    const countRows: Array<{ n: number }> = await this.ds.query(
      `SELECT COUNT(*)::int AS n FROM customer_prices cp WHERE ${where}`,
      params,
    );
    const total = Number(countRows[0]?.n ?? 0);

    params.push(opts.limit);
    const limIdx = params.length;
    params.push(opts.offset);
    const offIdx = params.length;

    const rows: Array<Record<string, unknown>> = await this.ds.query(
      `
      SELECT cp.id                              AS "id",
             cp.customer_id                     AS "customerId",
             c.customer_number                  AS "customerNumber",
             cp.item_id                         AS "itemId",
             ic.item_number                     AS "itemNumber",
             COALESCE(ic.name_ar, ic.item_name) AS "productName",
             cp.barcode                         AS "barcode",
             cp.unit_price                      AS "unitPrice",
             cp.price_source                    AS "priceSource",
             cp.origin                          AS "origin",
             c.allow_manual_price_edit          AS "allowManualPriceEdit",
             c.erp_price_list_name              AS "erpPriceListName"
      FROM customer_prices cp
      JOIN customers c ON c.id = cp.customer_id
      LEFT JOIN item_cart ic ON ic.id = cp.item_id
      WHERE ${where}
      ORDER BY c.customer_number, COALESCE(ic.name_ar, ic.item_name)
      LIMIT $${limIdx} OFFSET $${offIdx}
      `,
      params,
    );

    return {
      items: rows.map((r) => ({
        id: r.id as string,
        customerId: r.customerId as string,
        customerNumber: (r.customerNumber as string) ?? '',
        itemId: (r.itemId as string) ?? null,
        itemNumber: (r.itemNumber as string) ?? null,
        productName: (r.productName as string) ?? null,
        barcode: (r.barcode as string) ?? null,
        unitPrice: Number(r.unitPrice ?? 0),
        priceSource: (r.priceSource as string) ?? null,
        origin: (r.origin as string) ?? 'erp',
        allowManualPriceEdit: (r.allowManualPriceEdit as boolean) ?? true,
        erpPriceListName: (r.erpPriceListName as string) ?? null,
      })),
      total,
    };
  }

  /**
   * Create or update a dashboard-authored contract price for (customer, item).
   * Stored as origin='local' so the ERP sync never overwrites or prunes it — it
   * wins over any mirrored price and the app reads it from the DB like any other.
   */
  async upsert(input: UpsertCustomerPriceInput): Promise<CustomerPrice> {
    if (!Number.isInteger(input.unitPrice) || input.unitPrice < 0) {
      throw new BadRequestException('unitPrice must be a non-negative integer (fils)');
    }
    const item = await this.items.findOne({ where: { id: input.itemId } });
    if (!item) throw new NotFoundException(`Item ${input.itemId} not found`);

    const erpSku = item.itemNumber; // one contract row per (customer, ERP sku)
    let row = await this.prices.findOne({
      where: { customerId: input.customerId, erpSku },
    });
    if (!row) row = this.prices.create({ customerId: input.customerId, erpSku });
    row.origin = 'local';
    row.itemId = item.id;
    row.itemUnitId = null; // base unit
    row.barcode = item.barcode ?? null;
    row.unitPrice = input.unitPrice;
    row.priceSource = 'CUSTOMER_PRICE';
    row.syncedAt = new Date();
    return this.prices.save(row);
  }

  /** Remove a customer price by id (hard delete — matches the sync's prune). */
  async remove(id: string): Promise<{ deleted: boolean }> {
    const row = await this.prices.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Customer price ${id} not found`);
    await this.prices.delete(id);
    return { deleted: true };
  }
}
