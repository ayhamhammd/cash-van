import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Keep the GPS fix taken when a voucher was saved, so a sale can be drawn on the
 * rep's tracking map. See docs/PLAN-voucher-sale-location.md.
 *
 * The app already sends repLat/repLng on every voucher — they drive the
 * proximity geofence — but nothing persisted them, so the sale's location was
 * discarded at the end of the request.
 *
 * All three columns are nullable, which is the honest shape: every historical
 * voucher has no fix, a rep indoors or with location off legitimately saves
 * without one, and a dashboard-created voucher has no rep position at all.
 */
export class VoucherSaleLocation1722100000000 implements MigrationInterface {
  name = 'VoucherSaleLocation1722100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "voucher_headers"
        ADD COLUMN "sale_lat" double precision,
        ADD COLUMN "sale_lng" double precision,
        ADD COLUMN "sale_accuracy_m" real
    `);

    // Partial: the map query only ever wants vouchers that actually carry a fix,
    // and on an existing database that is none of them — so the index stays tiny
    // and grows only as located sales arrive.
    await queryRunner.query(`
      CREATE INDEX "idx_voucher_headers_sale_point"
        ON "voucher_headers" ("user_code", "in_date")
        WHERE "sale_lat" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_voucher_headers_sale_point"`,
    );
    await queryRunner.query(`
      ALTER TABLE "voucher_headers"
        DROP COLUMN IF EXISTS "sale_accuracy_m",
        DROP COLUMN IF EXISTS "sale_lng",
        DROP COLUMN IF EXISTS "sale_lat"
    `);
  }
}
