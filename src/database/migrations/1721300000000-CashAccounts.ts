import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EOD rep cash accounts (boxes) + their ledger. See docs/SPEC-eod-rep-cash-accounts.md.
 * cash_accounts = sales/receipts/cheque boxes (per-rep or shared) + company accounts,
 * optionally linked to an ERP GL account. account_transactions = signed ledger; balances
 * are derived (SUM), auto-entries idempotent per source ref.
 */
export class CashAccounts1721300000000 implements MigrationInterface {
  name = 'CashAccounts1721300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "cash_accounts" (
        "id"               uuid NOT NULL DEFAULT uuid_generate_v4(),
        "code"             text NOT NULL,
        "name"             text NOT NULL,
        "kind"             text NOT NULL,
        "rep_id"           uuid,
        "erp_account_id"   text,
        "erp_account_code" text,
        "is_active"        boolean NOT NULL DEFAULT true,
        "created_at"       timestamptz NOT NULL DEFAULT now(),
        "updated_at"       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_cash_accounts" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_cash_accounts_code" ON "cash_accounts" ("code")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_cash_accounts_rep_kind" ON "cash_accounts" ("rep_id","kind")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "account_transactions" (
        "id"            uuid NOT NULL DEFAULT uuid_generate_v4(),
        "account_id"    uuid NOT NULL,
        "entry_kind"    text NOT NULL,
        "amount_fils"   bigint NOT NULL,
        "label"         text NOT NULL,
        "rep_id"        uuid,
        "ref_type"      text,
        "ref_id"        text,
        "settlement_id" uuid,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_account_transactions" PRIMARY KEY ("id"),
        CONSTRAINT "fk_acct_txn_account" FOREIGN KEY ("account_id")
          REFERENCES "cash_accounts" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_acct_txn_account_created" ON "account_transactions" ("account_id","created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_acct_txn_settlement" ON "account_transactions" ("settlement_id")`,
    );
    // Idempotency: one auto-entry per (source doc, kind). Settlement rows have NULL ref.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_acct_txn_ref" ON "account_transactions" ("ref_type","ref_id","entry_kind")
       WHERE "ref_type" IS NOT NULL AND "ref_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "account_transactions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "cash_accounts"`);
  }
}
