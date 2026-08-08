import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Van stock requests: a salesman asks for goods to be loaded onto their van, a
 * manager grants all or part of it, and the salesman confirms receipt — which is
 * what raises the TRANSFER voucher that moves the stock.
 */
export class StockRequests1723200000000 implements MigrationInterface {
  name = 'StockRequests1723200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "stock_requests" (
        "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "request_number"          text        NOT NULL,
        "status"                  text        NOT NULL DEFAULT 'pending',
        "requester_user"          uuid        NOT NULL,
        "rep_id"                  uuid,
        "van_store_number"        text        NOT NULL,
        "source_store_number"     text,
        "note"                    text,
        "reviewer_user"           uuid,
        "decision_note"           text,
        "transfer_voucher_number" text,
        "created_at"              timestamptz NOT NULL DEFAULT now(),
        "decided_at"              timestamptz,
        "received_at"             timestamptz
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "stock_request_items" (
        "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "request_id"          uuid           NOT NULL
          REFERENCES "stock_requests"("id") ON DELETE CASCADE,
        "item_number"         text           NOT NULL,
        "item_name"           text           NOT NULL,
        "stock_unit_code"     text           NOT NULL DEFAULT '',
        "item_unit_id"        uuid,
        "unit_name"           text,
        "unit_base_qty"       integer        NOT NULL DEFAULT 1,
        "qty_of_unit"         numeric(14,3)  NOT NULL,
        "base_qty"            numeric(14,3)  NOT NULL,
        "approved_base_qty"   numeric(14,3),
        "van_qty_at_request"  numeric(14,3)  NOT NULL DEFAULT 0
      )
    `);

    // Unique: the app derives the next number from MAX(request_number), so two
    // simultaneous requests can compute the same one. This is what turns that
    // race into a failed insert instead of two requests sharing a number.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_stock_requests_number" ON "stock_requests" ("request_number")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_stock_requests_status" ON "stock_requests" ("status", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_stock_requests_rep" ON "stock_requests" ("rep_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_stock_request_items_request" ON "stock_request_items" ("request_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "stock_request_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "stock_requests"`);
  }
}
