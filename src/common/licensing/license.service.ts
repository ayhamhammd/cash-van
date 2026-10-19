import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface LicenseInfo {
  valid: boolean;
  reason?: string;
  /**
   * OUR id for the company — the one row-level security filters on.
   *
   * Not the same value the CRM knows it by. Two databases mean two ids for one
   * company, and the licence answers in the CRM's language; `crm_tenant_id` on
   * our own `tenants` row is the translation. Using the CRM's id directly binds
   * the connection to a company that does not exist here, and every query then
   * returns nothing — which looks exactly like a wrong password.
   */
  tenantId?: string;
  /** What the CRM calls this company. Kept for logs and support. */
  crmTenantId?: string;
  tenantCode?: string;
  /**
   * Our name for the company, read from our own `tenants` row rather than the
   * licence. The login screen shows it back before a password is typed, which
   * is the only way someone can tell a mistyped key from a wrong password —
   * both otherwise end at "Invalid credentials".
   */
  tenantName?: string;
  features: string[];
  /** False when unpaid or expired: reads stay, writes are refused. */
  writesAllowed: boolean;
}

interface CacheEntry {
  info: LicenseInfo;
  fetchedAt: number;
}

/**
 * Resolves a license key to a company and its entitlements, by asking the CRM.
 *
 * WHY THIS EXISTS AT ALL
 * Login has to read the users table before anyone knows which company the
 * caller belongs to — and `user_number` is only unique per company now, so
 * `admin@admin.com` can exist in twenty of them. The key answers "which
 * company" before authentication, which is what makes per-company usernames
 * work. It authenticates nobody: whoever holds it still has to sign in as a
 * real user of that company, so a leaked key buys a login screen and nothing
 * else.
 *
 * CACHING
 * Every request would otherwise be a round trip to the CRM. Entries are held
 * briefly so a suspension takes effect in seconds rather than instantly — the
 * trade is deliberate, and the TTL is the lever.
 *
 * WHEN THE CRM IS UNREACHABLE
 * A stale entry keeps being served, well past its TTL, rather than failing
 * closed. An outage of the control plane must not stop vans selling: the
 * company already paid, and refusing them service to protect a billing check
 * is the wrong trade. With no cached entry at all there is nothing to go on,
 * and the request is refused.
 */
@Injectable()
export class LicenseService {
  private readonly logger = new Logger(LicenseService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly crmBaseUrl: string;

  /** CRM tenant id -> our own row. Immutable once known, so cached forever. */
  private readonly tenantIdMap = new Map<string, { id: string; name: string }>();

  constructor(
    private readonly config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    this.crmBaseUrl = (config.get<string>('licensing.crmBaseUrl') ?? '').replace(
      /\/+$/,
      '',
    );
    this.ttlMs = config.get<number>('licensing.cacheTtlMs') ?? 60_000;
    this.staleMs = config.get<number>('licensing.staleGraceMs') ?? 86_400_000;
  }

  get enabled(): boolean {
    return this.crmBaseUrl.length > 0;
  }

  /**
   * Translates the CRM's id for a company into ours.
   *
   * `tenants` carries no tenant_id and no row-level security — it IS the
   * registry of companies — so this lookup is safe to run unscoped, which it
   * has to be: at this point nothing is scoped yet.
   */
  private async toLocalTenant(
    crmTenantId: string,
  ): Promise<{ id: string; name: string } | undefined> {
    const cached = this.tenantIdMap.get(crmTenantId);
    if (cached) return cached;
    const rows: { id: string; name: string }[] = await this.dataSource.query(
      `SELECT id, name FROM tenants WHERE crm_tenant_id = $1 LIMIT 1`,
      [crmTenantId],
    );
    const row = rows[0];
    if (row) this.tenantIdMap.set(crmTenantId, row);
    else {
      this.logger.warn(
        `Licence names CRM company ${crmTenantId}, which has never been ` +
          'provisioned here. Provision it before issuing a key for it.',
      );
    }
    return row;
  }

  async resolve(key: string): Promise<LicenseInfo | null> {
    if (!this.enabled || !key) return null;

    const cached = this.cache.get(key);
    const age = cached ? Date.now() - cached.fetchedAt : Infinity;
    if (cached && age < this.ttlMs) return cached.info;

    try {
      const res = await fetch(`${this.crmBaseUrl}/api/v1/licenses/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Naming ourselves matters now that one key opens several
        // applications: the answer then also says whether VanFlow in
        // particular is switched on for this company, instead of only whether
        // the company may work at all.
        body: JSON.stringify({ key, app: 'cashvan' }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`CRM returned ${res.status}`);
      const body = (await res.json()) as { data?: Partial<LicenseInfo> };
      const d = body.data ?? {};
      const local = d.tenantId ? await this.toLocalTenant(d.tenantId) : undefined;
      const info: LicenseInfo = {
        valid: d.valid === true,
        reason: d.reason,
        tenantId: local?.id,
        tenantName: local?.name,
        crmTenantId: d.tenantId,
        tenantCode: d.tenantCode,
        features: d.features ?? [],
        writesAllowed: d.writesAllowed === true,
      };
      this.cache.set(key, { info, fetchedAt: Date.now() });
      return info;
    } catch (err) {
      if (cached && age < this.staleMs) {
        this.logger.warn(
          `CRM unreachable (${(err as Error).message}) — serving a cached license ` +
            `${Math.round(age / 1000)}s old rather than stopping work.`,
        );
        return cached.info;
      }
      this.logger.error(
        `CRM unreachable and no usable cached license: ${(err as Error).message}`,
      );
      return null;
    }
  }
}
