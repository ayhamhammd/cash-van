import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ClsService } from 'nestjs-cls';
import { DataSource } from 'typeorm';

import { TENANT_EM_KEY } from './tenant-db.service';
import { USER_CTX_KEY, UserContext } from '../context/user-context.service';

/**
 * Runs a block of work bound to one tenant.
 *
 * Opens a transaction, pins `app.tenant_id` to its connection with SET LOCAL,
 * and publishes the transaction's EntityManager on CLS so `TenantDb` picks it
 * up. SET LOCAL is deliberate: it is scoped to the transaction, so the setting
 * cannot survive on the pooled connection and leak into the next request that
 * borrows it.
 *
 * Used by `TenantScopeInterceptor` for HTTP requests, and directly by
 * background jobs and the scheduled tasks that loop over tenants.
 */
@Injectable()
export class TenantScope {
  constructor(
    private readonly cls: ClsService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async runWith<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      // set_config rather than SET LOCAL because SET takes no bind parameters
      // and interpolating a tenant id into DDL-ish SQL is how injection starts.
      // The third argument is is_local: true confines the setting to THIS
      // transaction, so it cannot survive on the pooled connection and leak
      // into whichever request borrows that connection next.
      await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      return this.cls.run({ ifNested: 'inherit' }, async () => {
        this.cls.set(TENANT_EM_KEY, manager);
        return fn();
      });
    });
  }

  /**
   * For work with no HTTP request behind it — job workers, CLI scripts — that
   * needs both a user context (audit log, role checks) and a tenant binding.
   */
  async runAs<T>(ctx: UserContext, fn: () => Promise<T>): Promise<T> {
    if (!ctx.tenantId) {
      throw new Error('runAs requires a tenantId on the user context');
    }
    return this.cls.run(async () => {
      this.cls.set(USER_CTX_KEY, ctx);
      return this.runWith(ctx.tenantId as string, fn);
    });
  }

  /**
   * Runs `fn` once per active tenant, each inside its own tenant scope.
   *
   * Scheduled work used to run once for the whole database. Under row-level
   * security a cron job with no tenant bound sees nothing at all, so every
   * recurring task has to become this loop — otherwise it silently stops doing
   * anything, which is the worst kind of broken.
   *
   * One tenant's failure does not stop the others; it is logged and the loop
   * continues, because a single company with bad data should not freeze
   * everyone else's overdue-invoice sweep.
   */
  async forEachTenant(
    fn: (tenantId: string) => Promise<void>,
    onError?: (tenantId: string, error: unknown) => void,
  ): Promise<void> {
    for (const tenantId of await this.activeTenantIds()) {
      try {
        await this.runWith(tenantId, () => fn(tenantId));
      } catch (error) {
        if (onError) onError(tenantId, error);
        else throw error;
      }
    }
  }

  /** Every tenant that is allowed to be processed by scheduled work. */
  async activeTenantIds(): Promise<string[]> {
    const rows: { id: string }[] = await this.dataSource.query(
      `SELECT id FROM tenants WHERE status = 'active' ORDER BY created_at`,
    );
    return rows.map((r) => r.id);
  }
}
