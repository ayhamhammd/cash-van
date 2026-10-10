import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `customers.assignSalesman` — the permission to move a customer to another
 * salesman (edit form, reassign button, bulk Excel assignment).
 *
 * Granted to everyone who could do it before it existed, so nobody loses access
 * on upgrade: managers (the reassign and Excel endpoints were theirs), and office
 * users holding `customers.edit` (the edit form could change the salesman).
 * Admins need nothing — they pass every permission check.
 */
export class CustomerAssignSalesmanPermission1728520000000 implements MigrationInterface {
  name = 'CustomerAssignSalesmanPermission1728520000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE users
         SET permissions = COALESCE(permissions, '[]'::jsonb) || '["customers.assignSalesman"]'::jsonb
       WHERE (role = 'manager' OR COALESCE(permissions, '[]'::jsonb) ? 'customers.edit')
         AND NOT (COALESCE(permissions, '[]'::jsonb) ? 'customers.assignSalesman')
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE users
         SET permissions = permissions - 'customers.assignSalesman'
       WHERE permissions ? 'customers.assignSalesman'
    `);
  }
}
