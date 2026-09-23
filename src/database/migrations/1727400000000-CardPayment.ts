import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Whether a salesman may take a sale on Visa.
 *
 * Off for everyone by default: a card sale needs a terminal the van may not
 * carry and a card-clearing account on the ERP side the company may not have
 * set up, so the office turns it on per salesman rather than every van gaining
 * an option the day this deploys.
 */
export class CardPayment1727400000000 implements MigrationInterface {
  name = 'CardPayment1727400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS can_use_card_payment boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users DROP COLUMN IF EXISTS can_use_card_payment`);
  }
}
