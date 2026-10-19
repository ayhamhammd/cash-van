import * as bcrypt from 'bcrypt';
import type { EntityManager } from 'typeorm';

/**
 * Reference data every company needs before it can be used.
 *
 * Transaction kinds are NOT global lookup data any more — the tenancy migration
 * made their key `(tenant_id, trans_kind)`, because each company owns its own
 * copy. A company created without them cannot post a single voucher: the
 * voucher write path reads `transaction_kinds.sign` to decide whether stock
 * moves out of the van or back into it.
 *
 * Which is why this lives in its own file rather than inside the CLI seed —
 * provisioning a company from the CRM has to run exactly the same thing.
 *
 * WHY RAW SQL WITH AN EXPLICIT tenant_id
 * The obvious version used repositories and a find-or-create, and leaned on
 * row-level security to keep each company's lookup to its own rows. That is
 * true for the application, which connects as an unprivileged role — but the
 * seed runs as the OWNER, and in the dev container the owner is a superuser.
 * Superusers bypass RLS entirely, so the find-or-create found the FIRST
 * company's rows and reported success while writing nothing for the rest.
 * Naming the tenant in the statement is correct no matter who runs it.
 */

const TRANSACTION_KINDS: Array<{ kind: string; name: string; sign: number }> = [
  { kind: 'SALE', name: 'بيع', sign: -1 }, // van out
  { kind: 'RETURN', name: 'مرتجع', sign: 1 }, // van in
  { kind: 'ORDER', name: 'طلبية', sign: 0 }, // reserve until fulfilled
  { kind: 'TRANSFER_IN', name: 'تحميل المركبة', sign: 1 }, // van in
  { kind: 'TRANSFER_OUT', name: 'تنزيل المركبة', sign: -1 }, // van out
  { kind: 'TRANSFER', name: 'تحويل بين المخازن', sign: 0 },
  { kind: 'IN', name: 'إدخال للمخزن', sign: 1 },
  { kind: 'OUT', name: 'إخراج من المخزن', sign: -1 },
  { kind: 'PURCHASE', name: 'شراء', sign: 1 },
  { kind: 'ADJUSTMENT', name: 'تسوية', sign: 0 },
  { kind: 'PAYMENT_IN', name: 'سند قبض', sign: 0 },
  { kind: 'PAYMENT_OUT', name: 'سند صرف', sign: 0 },
];

/**
 * Seeds one company. Idempotent — every statement is an upsert on the natural
 * key, so re-running is safe and a partially-seeded company is completed
 * rather than duplicated.
 *
 * `withAdmin` creates the default `admin` / `admin1234` login. On for a
 * single-company install, where somebody has to be able to sign in at all; off
 * for a company provisioned from the CRM, whose users come from there and which
 * should not quietly acquire a well-known password.
 */
export async function seedTenant(
  manager: EntityManager,
  tenantId: string,
  options: {
    withAdmin: boolean;
    /** Defaults to the historic admin/admin1234 for a single-company install. */
    adminUserNumber?: string;
    adminPassword?: string;
    adminName?: string;
    /** The company's own name, for its settings row. */
    companyName?: string;
    /** Its short code, used by the mobile guard as `company_number`. */
    companyNumber?: string;
  },
): Promise<void> {
  for (const k of TRANSACTION_KINDS) {
    await manager.query(
      `INSERT INTO transaction_kinds (tenant_id, trans_kind, trans_name, sign)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, trans_kind) DO NOTHING`,
      [tenantId, k.kind, k.name, k.sign],
    );
  }

  // Every company needs its own settings row.
  //
  // Without one the settings screen is blank, `company_number` — which the
  // mobile guard checks on every rep request — is missing, and tax mode, ERP
  // credentials and the company's own name have nowhere to live. Before
  // company scoping was fixed in the token this was invisible: a provisioned
  // company with no row of its own silently read the DEFAULT company's, which
  // looked like it worked and was in fact a leak.
  //
  // `id` is 1 in every company — the primary key is (tenant_id, id), so one
  // settings row per company is exactly what that expresses.
  await manager.query(
    `INSERT INTO app_settings (tenant_id, id, company_name_ar, company_name_en, company_number)
     VALUES ($1, 1, $2, $2, $3)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [tenantId, options.companyName ?? 'My Company', options.companyNumber ?? 'C001'],
  );

  if (!options.withAdmin) return;

  // Per-company username: `uq_users_user_number` is (tenant_id, user_number)
  // now, so every company can have its own `admin` — or its own
  // `admin@admin.com` — without colliding. Which one a login means is decided
  // by the licence key that resolved the tenant.
  const userNumber = options.adminUserNumber ?? 'admin';
  const password = options.adminPassword ?? 'admin1234';
  const name = options.adminName ?? 'Default Admin';

  await manager.query(
    `INSERT INTO users (
       tenant_id, user_number, name, name_ar, name_en, password_hash,
       role, user_type, is_active,
       can_make_voucher, can_edit_voucher, can_add_customer,
       can_edit_customer_credit, can_add_items, can_edit_expiry,
       can_create_customer_direct, can_request_stock, can_approve_stock_request
     )
     VALUES ($1, $2, $3, $3, $3, $4,
             'admin', 'ADMIN', true,
             true, true, true, true, true, true,
             true, true, true)
     ON CONFLICT (tenant_id, user_number) DO NOTHING`,
    [tenantId, userNumber, name, await bcrypt.hash(password, 12)],
  );
}
