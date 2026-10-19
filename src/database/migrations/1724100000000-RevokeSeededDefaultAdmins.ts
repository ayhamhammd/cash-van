import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Close a hole this project opened itself.
 *
 * The boot seed looped every active company and created the historic
 * `admin` / `admin1234` login in each one. That password is in the README, in
 * this repository's history, and in every set of notes anyone has written about
 * this system. Combined with a licence key — which lives on every phone and
 * every office browser the customer owns, and which is meant to be shared
 * freely inside the company — it was full administrator access to that
 * company's data for anyone who had ever glanced at a screen.
 *
 * It also falsified the reasoning the whole licensing model rests on: that a
 * leaked key "buys a login screen and nothing else". It did not.
 *
 * DISABLED, NOT DELETED. These rows may already be referenced by audit entries,
 * vouchers or approvals, and a foreign key failure mid-migration on a customer's
 * production database is a worse morning than a disabled row. Disabling is
 * enough: `AuthService.login` refuses an inactive user after the password check.
 * The password is scrambled as well, so the account cannot be re-enabled into a
 * known-credentials state by accident.
 *
 * Only CRM-provisioned companies are touched. A single-company or on-premise
 * install genuinely needs its default login — that is the only way anyone signs
 * in there the first time — and nothing about it changed.
 */
export class RevokeSeededDefaultAdmins1724100000000 implements MigrationInterface {
  name = 'RevokeSeededDefaultAdmins1724100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: { code: string }[] = await queryRunner.query(`
      UPDATE users u
         SET is_active = false,
             -- Not a valid bcrypt hash, so no password can ever match it. The
             -- prefix says why, for whoever finds this row later.
             password_hash = 'disabled:seeded-default-admin:' || gen_random_uuid()
        FROM tenants t
       WHERE t.id = u.tenant_id
         AND t.crm_tenant_id IS NOT NULL
         AND u.user_number = 'admin'
         AND u.is_active = true
      RETURNING t.code
    `);

    if (rows.length) {
      // Loud on purpose. Anyone who used one of these to sign in is about to
      // find it stops working, and they should be able to find out why from
      // the deploy log rather than from a support ticket.
      // eslint-disable-next-line no-console
      console.warn(
        `Disabled the seeded default 'admin' account in ${rows.length} ` +
          `CRM-provisioned companies: ${rows.map((r) => r.code).join(', ')}. ` +
          'Each keeps the admin the CRM created for it.',
      );
    }
  }

  /**
   * Deliberately not reversible.
   *
   * `down()` would have to re-enable an account whose password is a documented
   * default, in companies that never asked for it. There is no state worth
   * returning to, and a rollback that quietly reopens a hole is worse than one
   * that does nothing.
   */
  public async down(): Promise<void> {
    // eslint-disable-next-line no-console
    console.warn(
      'RevokeSeededDefaultAdmins is not reversible — it would restore a ' +
        'well-known password in companies that should never have had it.',
    );
  }
}
