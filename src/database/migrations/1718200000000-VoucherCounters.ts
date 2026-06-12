import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-(store, transKind) voucher numbering. Each store + kind gets its own
 * running serial (more readable than one global counter). Seeded from any
 * existing vouchers (max trailing 6-digit serial) so new numbers don't collide.
 */
export class VoucherCounters1718200000000 implements MigrationInterface {
  name = 'VoucherCounters1718200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "voucher_counters" (
        "store_number" text NOT NULL,
        "trans_kind"   text NOT NULL,
        "last_number"  bigint NOT NULL DEFAULT 0,
        PRIMARY KEY ("store_number", "trans_kind")
      )
    `);

    // Seed counters from existing vouchers: max trailing 6-digit serial per
    // (store, kind). Store is the line's from/store/to; serial = last 6 digits.
    await queryRunner.query(`
      INSERT INTO "voucher_counters" ("store_number", "trans_kind", "last_number")
      SELECT store, trans_kind, MAX(serial)
      FROM (
        SELECT h.trans_kind AS trans_kind,
               COALESCE(t.from_store_number, t.store_number, t.to_store_number) AS store,
               CAST(RIGHT(h.voucher_number, 6) AS bigint) AS serial
        FROM "voucher_headers" h
        JOIN "voucher_transactions" t ON t.voucher_number = h.voucher_number
        WHERE h.voucher_number ~ '[0-9]{6}$'
      ) x
      WHERE x.store IS NOT NULL
      GROUP BY store, trans_kind
      ON CONFLICT ("store_number", "trans_kind")
        DO UPDATE SET "last_number" = GREATEST("voucher_counters"."last_number", EXCLUDED."last_number")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "voucher_counters"`);
  }
}
