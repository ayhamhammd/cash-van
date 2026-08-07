import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-row discount on the printed receipt, as a salesman permission.
 *
 * Some customers must not see the discount broken out per line — a wholesaler
 * given a better rate than the shop next door does not want it on a slip that
 * ends up on a counter. So it is a permission, not a print setting: it follows
 * the salesman, not the printer.
 *
 * Default false: the receipt keeps today's behaviour until someone is granted it.
 */
export class PrintLineDiscount1723100000000 implements MigrationInterface {
  name = 'PrintLineDiscount1723100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "users"
        ADD COLUMN "can_print_line_discount" boolean NOT NULL DEFAULT false`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" DROP COLUMN "can_print_line_discount"`);
  }
}
