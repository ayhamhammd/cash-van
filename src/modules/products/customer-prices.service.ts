import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** One customer's contract/list price for a product (unit), mirrored from the ERP. */
export interface CustomerPriceRow {
  customerId: string;
  customerNumber: string;
  itemId: string | null;
  itemNumber: string | null;
  productName: string | null;
  barcode: string | null;
  unitPrice: number; // fils
  priceSource: string | null;
  allowManualPriceEdit: boolean;
  erpPriceListName: string | null;
}

@Injectable()
export class CustomerPricesService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /**
   * Customer contract prices (optionally for one customer), offset-paginated.
   * Read-only mirror of the ERP; consumed by the mobile app (offline cache) and
   * the dashboard customer profile.
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
      SELECT cp.customer_id                     AS "customerId",
             c.customer_number                  AS "customerNumber",
             cp.item_id                         AS "itemId",
             ic.item_number                     AS "itemNumber",
             COALESCE(ic.name_ar, ic.item_name) AS "productName",
             cp.barcode                         AS "barcode",
             cp.unit_price                      AS "unitPrice",
             cp.price_source                    AS "priceSource",
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
        customerId: r.customerId as string,
        customerNumber: (r.customerNumber as string) ?? '',
        itemId: (r.itemId as string) ?? null,
        itemNumber: (r.itemNumber as string) ?? null,
        productName: (r.productName as string) ?? null,
        barcode: (r.barcode as string) ?? null,
        unitPrice: Number(r.unitPrice ?? 0),
        priceSource: (r.priceSource as string) ?? null,
        allowManualPriceEdit: (r.allowManualPriceEdit as boolean) ?? true,
        erpPriceListName: (r.erpPriceListName as string) ?? null,
      })),
      total,
    };
  }
}
