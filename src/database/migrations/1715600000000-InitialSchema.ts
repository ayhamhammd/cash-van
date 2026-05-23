import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial schema for the Cash Van backend.
 *
 * Conventions:
 *   - snake_case column / table names
 *   - UUID primary keys via gen_random_uuid() (pgcrypto)
 *   - timestamptz for all timestamps, with createdAt/updatedAt/deletedAt
 *   - explicit indexes on FK columns (PG does not create them automatically)
 *   - numeric() for money and qty (never float)
 */
export class InitialSchema1715600000000 implements MigrationInterface {
  name = 'InitialSchema1715600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // ---- users ---------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_number"              TEXT NOT NULL,
        "name"                     TEXT NOT NULL,
        "password_hash"            TEXT NOT NULL,
        "user_type"                TEXT NOT NULL DEFAULT 'SALES',
        "is_active"                BOOLEAN NOT NULL DEFAULT TRUE,
        "can_make_voucher"         BOOLEAN NOT NULL DEFAULT FALSE,
        "can_edit_voucher"         BOOLEAN NOT NULL DEFAULT FALSE,
        "can_add_customer"         BOOLEAN NOT NULL DEFAULT FALSE,
        "can_edit_customer_credit" BOOLEAN NOT NULL DEFAULT FALSE,
        "can_add_items"            BOOLEAN NOT NULL DEFAULT FALSE,
        "can_edit_expiry"          BOOLEAN NOT NULL DEFAULT FALSE,
        "created_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"               TIMESTAMPTZ,
        "version"                  INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT "uq_users_user_number" UNIQUE ("user_number"),
        CONSTRAINT "ck_users_user_type" CHECK ("user_type" IN ('ADMIN','MANAGER','SALES','DRIVER'))
      )
    `);

    // ---- customers -----------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "customers" (
        "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "customer_number"  TEXT NOT NULL,
        "customer_name"    TEXT NOT NULL,
        "location"         TEXT,
        "longitude"        NUMERIC(9,6),
        "latitude"         NUMERIC(9,6),
        "credit_limit"     NUMERIC(14,2) NOT NULL DEFAULT 0,
        "customer_type"    TEXT NOT NULL DEFAULT 'CASH',
        "total_debt"       NUMERIC(14,2) NOT NULL DEFAULT 0,
        "total_credit"     NUMERIC(14,2) NOT NULL DEFAULT 0,
        "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"       TIMESTAMPTZ,
        "version"          INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT "uq_customers_customer_number" UNIQUE ("customer_number"),
        CONSTRAINT "ck_customers_customer_type" CHECK ("customer_type" IN ('CASH','CREDIT','WHOLESALE','RETAIL'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_customers_customer_name" ON "customers" ("customer_name")`);

    // ---- vendors -------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "vendors" (
        "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "vendor_number"  TEXT NOT NULL,
        "vendor_name"    TEXT NOT NULL,
        "vendor_phone"   TEXT,
        "vendor_debit"   NUMERIC(14,2) NOT NULL DEFAULT 0,
        "vendor_credit"  NUMERIC(14,2) NOT NULL DEFAULT 0,
        "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"     TIMESTAMPTZ,
        "version"        INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT "uq_vendors_vendor_number" UNIQUE ("vendor_number")
      )
    `);

    // ---- warehouses ----------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "warehouses" (
        "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "wh_number"      TEXT NOT NULL,
        "wh_name"        TEXT NOT NULL,
        "wh_credit_box"  NUMERIC(14,2) NOT NULL DEFAULT 0,
        "wh_debit_box"   NUMERIC(14,2) NOT NULL DEFAULT 0,
        "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"     TIMESTAMPTZ,
        "version"        INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT "uq_warehouses_wh_number" UNIQUE ("wh_number")
      )
    `);

    // ---- item_cart ------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "item_cart" (
        "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "item_number"     TEXT NOT NULL,
        "item_name"       TEXT NOT NULL,
        "barcode"         TEXT NOT NULL,
        "tax_percentage"  NUMERIC(5,2) NOT NULL DEFAULT 0,
        "photo_url"       TEXT,
        "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"      TIMESTAMPTZ,
        "version"         INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT "uq_item_cart_item_number" UNIQUE ("item_number"),
        CONSTRAINT "uq_item_cart_barcode" UNIQUE ("barcode")
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_item_cart_item_name" ON "item_cart" ("item_name")`);

    // ---- item_switch ----------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "item_switch" (
        "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "item_number"  TEXT NOT NULL REFERENCES "item_cart"("item_number") ON DELETE CASCADE,
        "barcode"      TEXT NOT NULL,
        "unit_qty"     INTEGER NOT NULL DEFAULT 1 CHECK ("unit_qty" > 0),
        "sale_price"   NUMERIC(14,2) NOT NULL CHECK ("sale_price" >= 0),
        "item_name"    TEXT NOT NULL,
        "unit_name"    TEXT NOT NULL,
        "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"   TIMESTAMPTZ,
        "version"      INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT "uq_item_switch_barcode" UNIQUE ("barcode"),
        CONSTRAINT "uq_item_switch_item_unit" UNIQUE ("item_number", "unit_name")
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_item_switch_item_number" ON "item_switch" ("item_number")`);

    // ---- expiry_items ---------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "expiry_items" (
        "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "item_number"   TEXT NOT NULL REFERENCES "item_cart"("item_number") ON DELETE CASCADE,
        "item_name"     TEXT NOT NULL,
        "exp_date"      DATE NOT NULL,
        "in_date"       DATE NOT NULL,
        "start_date"    DATE,
        "store_number"  TEXT REFERENCES "warehouses"("wh_number") ON DELETE RESTRICT,
        "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"    TIMESTAMPTZ,
        "version"       INTEGER NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_expiry_items_exp_date" ON "expiry_items" ("exp_date")`);
    await queryRunner.query(`CREATE INDEX "idx_expiry_items_item_number" ON "expiry_items" ("item_number")`);
    await queryRunner.query(`CREATE INDEX "idx_expiry_items_store_number" ON "expiry_items" ("store_number")`);

    // ---- transaction_kinds ----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "transaction_kinds" (
        "trans_kind"  TEXT PRIMARY KEY,
        "trans_name"  TEXT NOT NULL,
        "sign"        SMALLINT NOT NULL DEFAULT 0 CHECK ("sign" IN (-1, 0, 1))
      )
    `);

    // ---- voucher_headers -----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "voucher_headers" (
        "id"                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "voucher_number"              TEXT NOT NULL,
        "user_code"                   TEXT NOT NULL REFERENCES "users"("user_number") ON DELETE RESTRICT,
        "in_date"                     TIMESTAMPTZ NOT NULL DEFAULT now(),
        "trans_kind"                  TEXT NOT NULL REFERENCES "transaction_kinds"("trans_kind") ON DELETE RESTRICT,
        "customer_number"             TEXT REFERENCES "customers"("customer_number") ON DELETE RESTRICT,
        "vendor_number"               TEXT REFERENCES "vendors"("vendor_number") ON DELETE RESTRICT,
        "total_tax"                   NUMERIC(14,2) NOT NULL DEFAULT 0,
        "total"                       NUMERIC(14,2) NOT NULL DEFAULT 0,
        "net_total"                   NUMERIC(14,2) NOT NULL DEFAULT 0,
        "total_discount_value"        NUMERIC(14,2) NOT NULL DEFAULT 0,
        "total_discount_percentage"   NUMERIC(5,2)  NOT NULL DEFAULT 0,
        "is_posted"                   BOOLEAN NOT NULL DEFAULT FALSE,
        "is_edit"                     BOOLEAN NOT NULL DEFAULT FALSE,
        "created_at"                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"                  TIMESTAMPTZ,
        "version"                     INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT "uq_voucher_headers_voucher_number" UNIQUE ("voucher_number")
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_voucher_headers_user_code" ON "voucher_headers" ("user_code")`);
    await queryRunner.query(`CREATE INDEX "idx_voucher_headers_customer_number" ON "voucher_headers" ("customer_number")`);
    await queryRunner.query(`CREATE INDEX "idx_voucher_headers_vendor_number" ON "voucher_headers" ("vendor_number")`);
    await queryRunner.query(`CREATE INDEX "idx_voucher_headers_trans_kind" ON "voucher_headers" ("trans_kind")`);
    await queryRunner.query(`CREATE INDEX "idx_voucher_headers_in_date" ON "voucher_headers" ("in_date")`);

    // ---- voucher_transactions -----------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "voucher_transactions" (
        "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "voucher_number"        TEXT NOT NULL REFERENCES "voucher_headers"("voucher_number") ON DELETE CASCADE,
        "item_number"           TEXT NOT NULL REFERENCES "item_cart"("item_number") ON DELETE RESTRICT,
        "item_name"             TEXT NOT NULL,
        "trans_kind"            TEXT NOT NULL REFERENCES "transaction_kinds"("trans_kind") ON DELETE RESTRICT,
        "store_number"          TEXT REFERENCES "warehouses"("wh_number") ON DELETE RESTRICT,
        "tax_percentage"        NUMERIC(5,2)  NOT NULL DEFAULT 0,
        "discount_percentage"   NUMERIC(5,2)  NOT NULL DEFAULT 0,
        "discount_value"        NUMERIC(14,2) NOT NULL DEFAULT 0,
        "real_date"             TIMESTAMPTZ NOT NULL DEFAULT now(),
        "exported_date"         TIMESTAMPTZ,
        "item_qty"              NUMERIC(14,3) NOT NULL CHECK ("item_qty" >= 0),
        "signed_qty"            NUMERIC(14,3) NOT NULL DEFAULT 0,
        "total"                 NUMERIC(14,2) NOT NULL DEFAULT 0,
        "net_total"             NUMERIC(14,2) NOT NULL DEFAULT 0,
        "created_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"            TIMESTAMPTZ,
        "version"               INTEGER NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_voucher_transactions_voucher_number" ON "voucher_transactions" ("voucher_number")`);
    await queryRunner.query(`CREATE INDEX "idx_voucher_transactions_item_number" ON "voucher_transactions" ("item_number")`);
    await queryRunner.query(`CREATE INDEX "idx_voucher_transactions_trans_kind" ON "voucher_transactions" ("trans_kind")`);
    await queryRunner.query(`CREATE INDEX "idx_voucher_transactions_store_number" ON "voucher_transactions" ("store_number")`);

    // ---- payments ------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "payments" (
        "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "voucher_number"  TEXT NOT NULL REFERENCES "voucher_headers"("voucher_number") ON DELETE CASCADE,
        "amount"          NUMERIC(14,2) NOT NULL CHECK ("amount" >= 0),
        "payment_date"    TIMESTAMPTZ NOT NULL DEFAULT now(),
        "from_acc"        TEXT,
        "to_acc"          TEXT,
        "payment_type"    TEXT NOT NULL DEFAULT 'CASH'
                           CHECK ("payment_type" IN ('CASH','CHEQUE','TRANSFER','CARD','CREDIT')),
        "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"      TIMESTAMPTZ,
        "version"         INTEGER NOT NULL DEFAULT 1
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_payments_voucher_number" ON "payments" ("voucher_number")`);
    await queryRunner.query(`CREATE INDEX "idx_payments_date" ON "payments" ("payment_date")`);

    // ---- payment_cheques -----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "payment_cheques" (
        "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "bank_name"        TEXT NOT NULL,
        "cheque_number"    TEXT NOT NULL,
        "cheque_date"      DATE NOT NULL,
        "due_date"         DATE NOT NULL,
        "amount"           NUMERIC(14,2) NOT NULL CHECK ("amount" >= 0),
        "customer_number"  TEXT REFERENCES "customers"("customer_number") ON DELETE RESTRICT,
        "customer_name"    TEXT,
        "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"       TIMESTAMPTZ,
        "version"          INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT "uq_payment_cheques_cheque_number" UNIQUE ("cheque_number")
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_payment_cheques_due_date" ON "payment_cheques" ("due_date")`);
    await queryRunner.query(`CREATE INDEX "idx_payment_cheques_customer_number" ON "payment_cheques" ("customer_number")`);

    // ---- year_config ---------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE "year_config" (
        "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "year"        SMALLINT NOT NULL CHECK ("year" BETWEEN 1900 AND 2999),
        "acc_name"    TEXT NOT NULL,
        "acc_value"   NUMERIC(18,4) NOT NULL DEFAULT 0,
        "total_sale"  NUMERIC(18,2) NOT NULL DEFAULT 0,
        "total_d"     NUMERIC(18,2) NOT NULL DEFAULT 0,
        "total_r"     NUMERIC(18,2) NOT NULL DEFAULT 0,
        "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at"  TIMESTAMPTZ,
        "version"     INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT "uq_year_config_year_acc" UNIQUE ("year", "acc_name")
      )
    `);

    // ---- item_balance view ---------------------------------------------------
    await queryRunner.query(`
      CREATE OR REPLACE VIEW "item_balance" AS
      SELECT
        ic.item_number               AS item_number,
        ic.item_name                 AS item_name,
        vt.store_number              AS stock_number,
        COALESCE(SUM(vt.signed_qty), 0)::numeric(14,3) AS qty
      FROM item_cart ic
      LEFT JOIN voucher_transactions vt
        ON vt.item_number = ic.item_number
      LEFT JOIN voucher_headers vh
        ON vh.voucher_number = vt.voucher_number
       AND vh.is_posted = TRUE
      GROUP BY ic.item_number, ic.item_name, vt.store_number
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP VIEW IF EXISTS "item_balance"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "year_config"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payment_cheques"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "voucher_transactions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "voucher_headers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "transaction_kinds"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "expiry_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "item_switch"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "item_cart"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "warehouses"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "vendors"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }
}
