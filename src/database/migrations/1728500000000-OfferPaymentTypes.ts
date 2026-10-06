import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Offers name the payment types they cover: `trigger.paymentTypes`, any of
 * CASH, CARD (Visa), CREDIT.
 *
 * The old `paymentCondition: 'CASH'` meant "anything but credit", so cash offers
 * also discounted Visa sales. Each one now becomes cash-only; the office adds
 * Visa back to the offers that should cover it. Credit offers are unchanged, and
 * offers without a condition stay ungated (every type).
 *
 * `paymentCondition` stays on the row for phones that read only it — the API
 * keeps it derived from `paymentTypes` on every save.
 */
export class OfferPaymentTypes1728500000000 implements MigrationInterface {
  name = 'OfferPaymentTypes1728500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE offers
         SET trigger = jsonb_set(trigger, '{paymentTypes}', '["CASH"]'::jsonb)
       WHERE trigger->>'paymentCondition' = 'CASH'
         AND NOT (trigger ? 'paymentTypes')
    `);
    await q.query(`
      UPDATE offers
         SET trigger = jsonb_set(trigger, '{paymentTypes}', '["CREDIT"]'::jsonb)
       WHERE trigger->>'paymentCondition' = 'CREDIT'
         AND NOT (trigger ? 'paymentTypes')
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Back to the legacy single condition. A list with CREDIT alone stays CREDIT;
    // anything else becomes CASH (which the old engine read as non-credit).
    await q.query(`
      UPDATE offers
         SET trigger = jsonb_set(
               trigger - 'paymentTypes',
               '{paymentCondition}',
               CASE WHEN trigger->'paymentTypes' = '["CREDIT"]'::jsonb
                    THEN '"CREDIT"'::jsonb ELSE '"CASH"'::jsonb END)
       WHERE trigger ? 'paymentTypes'
    `);
  }
}
