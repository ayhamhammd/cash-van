import { ConflictException, Injectable, Logger } from '@nestjs/common';

import { Tenant } from './entities/tenant.entity';
import { TenantDataSource } from '../../common/tenancy/tenant-data-source.service';
import { TenantScope } from '../../common/tenancy/tenant-scope.service';
import { seedTenant } from '../../database/seeds/tenant-seed';
import { encryptSecret } from '../../common/crypto/secret.util';
import * as bcrypt from 'bcrypt';

export interface ProvisionTenantInput {
  crmTenantId: string;
  code: string;
  name: string;
  /**
   * The company's first login, created by the CRM.
   *
   * Without it a provisioned company has no way in: nobody can sign in, so
   * nobody can create the reps and sub-admins that the admin is supposed to
   * create. The licence key says which company; this is the only user in it.
   */
  adminUserNumber?: string;
  adminPassword?: string;
  adminName?: string;
}

/**
 * Creates the companies the CRM provisions.
 *
 * Runs UNSCOPED on purpose — `tenants` is the registry of companies, not a
 * table belonging to one, and there is no tenant bound to the connection when
 * a company is being created for the first time.
 */
@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly ds: TenantDataSource,
    private readonly scope: TenantScope,
  ) {}

  /**
   * Idempotent on `crm_tenant_id`.
   *
   * The CRM retries a failed provisioning call, and the failure it retries
   * after may be a timeout on a request that actually succeeded. Returning the
   * existing row is what stops that from creating a second company here that
   * the CRM would never point at.
   */
  async provision(input: ProvisionTenantInput): Promise<Tenant> {
    const code = input.code.trim().toUpperCase();

    // A code already held by a DIFFERENT company here. Almost always an
    // orphan: the CRM record was deleted, this one stayed (we hold their data
    // and will not throw it away on a tidy-up), and someone has now recreated
    // the company under the same code. Left to the unique index this surfaces
    // as "duplicate key", which tells the operator nothing about which of the
    // two systems is unhappy or what to do next.
    //
    // Refused rather than adopted. Adopting would hand a brand-new company
    // somebody else's invoices the moment two customers picked the same code,
    // and that is not a mistake you can undo.
    const clash: { id: string; crm_tenant_id: string | null }[] =
      await this.ds.unscoped.query(
        `SELECT id, crm_tenant_id FROM tenants
          WHERE code = $1 AND crm_tenant_id IS DISTINCT FROM $2 LIMIT 1`,
        [code, input.crmTenantId],
      );
    if (clash.length) {
      throw new ConflictException({
        message:
          `A company with code ${code} already exists here, and it belongs to a ` +
          'different CRM record. Its data is still held. Either archive it first ' +
          'or provision under a different code.',
        code: 'tenant_code_taken',
      });
    }

    const rows: Tenant[] = await this.ds.unscoped.query(
      `INSERT INTO tenants (code, name, crm_tenant_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (crm_tenant_id) WHERE crm_tenant_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name
       RETURNING id, code, name, status, crm_tenant_id AS "crmTenantId", created_at AS "createdAt"`,
      [input.code.trim().toUpperCase(), input.name.trim(), input.crmTenantId],
    );
    const tenant = rows[0];

    // Reference data, inside the new company's own scope. Without transaction
    // kinds the company exists but cannot post a voucher — the write path
    // reads `transaction_kinds.sign` to decide which way stock moves — so a
    // company provisioned without them looks fine until the first sale fails.
    //
    // No admin user: this company's people come from the CRM, and a new
    // company should not quietly acquire a well-known default password.
    await this.scope.runWith(tenant.id, async () => {
      await seedTenant(this.ds.manager, tenant.id, {
        withAdmin: Boolean(input.adminUserNumber && input.adminPassword),
        adminUserNumber: input.adminUserNumber,
        adminPassword: input.adminPassword,
        adminName: input.adminName,
        companyName: tenant.name,
        companyNumber: tenant.code,
      });
    });

    this.logger.log(`Provisioned tenant ${tenant.code} (${tenant.id})`);
    return tenant;
  }

  /**
   * Point this company at its own ERP, on the CRM's word.
   *
   * Until now the two products were introduced by hand: someone opened the
   * cash-van settings screen, typed the ERP's address, and pasted a key they
   * had generated over there. For a cloud customer that step is pure
   * ceremony — the CRM provisioned both sides and knows exactly which ERP
   * organisation belongs to which cash-van company. It can just say so.
   *
   * The settings screen stays, and stays authoritative for anyone typing in
   * it. This only fills in what nobody has set: an install already pointed at
   * an ERP is left alone rather than repointed underneath a working customer.
   * That matters for on-premise sites, where the address is a machine on their
   * own network and the CRM has no business guessing it.
   */
  async linkErp(input: {
    crmTenantId: string;
    baseUrl: string;
    apiKey?: string | null;
    vanStore?: string | null;
  }): Promise<{ linked: boolean; reason?: string }> {
    const rows: { id: string }[] = await this.ds.unscoped.query(
      `SELECT id FROM tenants WHERE crm_tenant_id = $1 LIMIT 1`,
      [input.crmTenantId],
    );
    const tenantId = rows[0]?.id;
    if (!tenantId) return { linked: false, reason: 'not_provisioned_here' };

    return this.scope.runWith(tenantId, async () => {
      const current: { erp_base_url: string | null; erp_api_key_encrypted: string | null }[] =
        await this.ds.manager.query(
          `SELECT erp_base_url, erp_api_key_encrypted FROM app_settings WHERE tenant_id = $1`,
          [tenantId],
        );

      // Someone has already configured this by hand. Leave it: they know
      // something we do not, and overwriting a working connection during a
      // routine re-provision is how an integration breaks on a Tuesday.
      if (current[0]?.erp_base_url && current[0]?.erp_api_key_encrypted) {
        return { linked: false, reason: 'already_configured' };
      }

      const baseUrl = input.baseUrl
        .trim()
        .replace(/\/+$/, '')
        .replace(/\/api(\/v\d+)?$/i, '');

      await this.ds.manager.query(
        `UPDATE app_settings
            SET erp_sync_enabled = true,
                erp_base_url = $2,
                erp_api_key_encrypted = COALESCE($3, erp_api_key_encrypted),
                erp_api_key_last4 = COALESCE($4, erp_api_key_last4),
                erp_van_store = COALESCE($5, erp_van_store)
          WHERE tenant_id = $1`,
        [
          tenantId,
          baseUrl,
          input.apiKey ? encryptSecret(input.apiKey) : null,
          input.apiKey ? input.apiKey.slice(-4) : null,
          input.vanStore ?? null,
        ],
      );

      this.logger.log(`Linked tenant ${tenantId} to its ERP at ${baseUrl}`);
      return { linked: true };
    });
  }

  /**
   * Retire a company without destroying it — what the CRM calls when its own
   * record is deleted.
   *
   * The data stays. All of it. We are not the system of record for whether a
   * customer still exists, and deleting a company's invoices because someone
   * tidied a list in another application is not a mistake anyone recovers from.
   *
   * What it does release is the CODE, by moving it aside. Codes are unique
   * here, so an orphan holding `MYTEST` blocks the next company that wants to
   * be called that — which is exactly the wall you hit if the CRM record is
   * recreated. Unlinking `crm_tenant_id` too, so the row cannot be picked up by
   * the licence lookup of whoever holds that CRM id next.
   *
   * Not an error when there is nothing to archive: the CRM calls this on the
   * way to deleting its own record, and a company that was never provisioned
   * here is a perfectly ordinary case.
   */
  async archive(crmTenantId: string): Promise<{ archived: boolean }> {
    // An UPDATE … RETURNING comes back from the driver as
    // [rows, affectedCount], NOT as a bare array like a SELECT does. Reading it
    // as one made `rows.length` 2 whatever happened — so this reported success
    // on a company it had never found, and logged "Archived tenant undefined".
    const result: unknown = await this.ds.unscoped.query(
      `UPDATE tenants
          SET status = 'archived',
              crm_tenant_id = NULL,
              -- Short id suffix rather than a timestamp: unique, stable, and
              -- it still reads as the code it used to be.
              code = code || '~' || left(id::text, 8)
        WHERE crm_tenant_id = $1
          AND status <> 'archived'
        RETURNING id, code`,
      [crmTenantId],
    );
    const rows = (Array.isArray(result) && Array.isArray(result[0])
      ? result[0]
      : result) as { id: string; code: string }[];

    if (!rows?.length) {
      this.logger.log(
        `Nothing to archive for CRM company ${crmTenantId} — it was never provisioned here.`,
      );
      return { archived: false };
    }
    this.logger.log(
      `Archived tenant ${rows[0].code} (${rows[0].id}) — its data is kept, its code is free again.`,
    );
    return { archived: true };
  }

  /**
   * Store a key the CRM set for this company, and switch on what it unlocks.
   *
   * The AI key is the interesting one: a key arriving does not only mean "we
   * can call the provider now", it means the AI screens should appear. Storing
   * the credential and leaving `ai_enabled` false would be a key that works and
   * a product that behaves as though it does not — the kind of half-state
   * somebody debugs for an afternoon.
   *
   * Clearing works the same way in reverse, and clears the stored value too. A
   * disabled feature sitting on a live credential is exactly the tidy-looking
   * state that surprises people later.
   */
  async setServiceKey(input: {
    crmTenantId: string;
    kind: 'maps' | 'ai' | 'jofotara';
    value?: string | null;
    source?: 'company' | 'platform' | 'none';
    meta?: Record<string, string>;
  }): Promise<{ stored: boolean; reason?: string }> {
    const rows: { id: string }[] = await this.ds.unscoped.query(
      `SELECT id FROM tenants WHERE crm_tenant_id = $1 LIMIT 1`,
      [input.crmTenantId],
    );
    const tenantId = rows[0]?.id;
    if (!tenantId) return { stored: false, reason: 'not_provisioned_here' };

    const value = input.value?.trim() || null;
    const last4 = value ? value.slice(-4) : null;
    const cipher = value ? encryptSecret(value) : null;

    return this.scope.runWith(tenantId, async () => {
      if (input.kind === 'maps') {
        await this.ds.manager.query(
          `UPDATE app_settings
              SET google_maps_key_encrypted = $2,
                  google_maps_key_last4 = $3,
                  keys_set_at = now()
            WHERE tenant_id = $1`,
          [tenantId, cipher, last4],
        );
      } else if (input.kind === 'ai') {
        const source = input.source ?? (value ? 'company' : 'none');
        await this.ds.manager.query(
          `UPDATE app_settings
              SET ai_api_key_encrypted = $2,
                  ai_api_key_last4 = $3,
                  ai_key_source = $4,
                  ai_enabled = $5,
                  ai_provider = COALESCE($6, ai_provider),
                  keys_set_at = now()
            WHERE tenant_id = $1`,
          [tenantId, cipher, last4, source, source !== 'none', input.meta?.provider ?? null],
        );
      } else {
        await this.ds.manager.query(
          `UPDATE app_settings
              SET jofotara_secret_key_encrypted = $2,
                  jofotara_secret_last4 = $3,
                  jofotara_client_id = COALESCE($4, jofotara_client_id),
                  keys_set_at = now()
            WHERE tenant_id = $1`,
          [tenantId, cipher, last4, input.meta?.clientId ?? null],
        );
      }
      this.logger.log(`Stored the ${input.kind} key for tenant ${tenantId}`);
      return { stored: true };
    });
  }

  /**
   * A new password for this company's super admin, set in the CRM.
   *
   * Matched on user number WITHIN the company — usernames are only unique per
   * company here, so the same email can be the admin of twenty of them and an
   * unscoped match would change the wrong person's password.
   */
  async setAdminPassword(input: {
    crmTenantId: string;
    email: string;
    password: string;
  }): Promise<{ updated: boolean; reason?: string }> {
    const rows: { id: string }[] = await this.ds.unscoped.query(
      `SELECT id FROM tenants WHERE crm_tenant_id = $1 LIMIT 1`,
      [input.crmTenantId],
    );
    const tenantId = rows[0]?.id;
    if (!tenantId) return { updated: false, reason: 'not_provisioned_here' };

    const hash = await bcrypt.hash(input.password, 10);
    return this.scope.runWith(tenantId, async () => {
      const result: unknown = await this.ds.manager.query(
        `UPDATE users
            SET password_hash = $3, is_active = true
          WHERE tenant_id = $1 AND lower(user_number) = lower($2)
          RETURNING id`,
        [tenantId, input.email, hash],
      );
      // UPDATE … RETURNING comes back as [rows, count], not a bare array.
      const updated = (Array.isArray(result) && Array.isArray(result[0])
        ? result[0]
        : result) as { id: string }[];
      if (!updated?.length) {
        this.logger.warn(
          `The CRM reset the password for ${input.email}, but this company has ` +
            'nobody with that username. Their VanFlow login is unchanged.',
        );
        return { updated: false, reason: 'user_not_found' };
      }
      this.logger.log(`Reset the admin password for tenant ${tenantId} on the CRM's word.`);
      return { updated: true };
    });
  }

  list(): Promise<Tenant[]> {
    return this.ds.unscoped.query(
      `SELECT id, code, name, status FROM tenants ORDER BY created_at`,
    );
  }
}
