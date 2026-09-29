import { MigrationInterface, QueryRunner } from 'typeorm';

export class CustomerAreaToErp1728000000000 implements MigrationInterface {
  name = 'CustomerAreaToErp1728000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      INSERT INTO erp_outbox (kind, ref, status, attempts, next_attempt_at)
      SELECT 'CUSTOMER_AREA', c.customer_number, 'pending', 0, now()
        FROM customers c
       WHERE c.area_id IS NOT NULL
         AND c.deleted_at IS NULL
         AND c.customer_number IS NOT NULL
      ON CONFLICT (kind, ref) DO NOTHING`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM erp_outbox WHERE kind = 'CUSTOMER_AREA'`);
  }
}
