import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F11.1 — add the VENDOR_RETURN transaction kind (returning goods to a
 * supplier). sign = -1: stock leaves our store, so it is guarded against the
 * from-store balance exactly like SALE/OUT. Uses a vendor (not a customer).
 */
export class VendorReturnKind1718600000000 implements MigrationInterface {
  name = 'VendorReturnKind1718600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO transaction_kinds (trans_kind, trans_name, sign)
         VALUES ('VENDOR_RETURN', 'مرتجع مورد', -1)
       ON CONFLICT (trans_kind) DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM transaction_kinds WHERE trans_kind = 'VENDOR_RETURN'`,
    );
  }
}
