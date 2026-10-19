import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ClsService } from 'nestjs-cls';
import {
  DataSource,
  EntityManager,
  EntityTarget,
  ObjectLiteral,
  Repository,
} from 'typeorm';

/** CLS slot holding the transaction-bound manager for the current request. */
export const TENANT_EM_KEY = 'tenantEntityManager';

/**
 * The only sanctioned way to reach the database from request-handling code.
 *
 * WHY NOT `@InjectRepository`
 * Row-level security reads `app.tenant_id`, a per-connection setting. TypeORM
 * pools connections, so the setting only holds on the connection the request's
 * transaction is using — the one `TenantScopeInterceptor` prepared. An injected
 * repository takes an arbitrary pooled connection where `app.tenant_id` is
 * unset, and every policy then matches nothing.
 *
 * That failure is loud (zero rows), never silent (someone else's rows), which
 * is what makes migrating the existing services safe to do module by module.
 */
@Injectable()
export class TenantDb {
  constructor(
    private readonly cls: ClsService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Manager bound to this request's transaction, with `app.tenant_id` already
   * set on its connection.
   */
  get manager(): EntityManager {
    const manager = this.cls.get<EntityManager | undefined>(TENANT_EM_KEY);
    if (!manager) {
      throw new InternalServerErrorException(
        'No tenant-scoped database context. This code path runs outside a ' +
          'request; wrap it in TenantScope.runWith(tenantId, …) so row-level ' +
          'security has a tenant to filter on.',
      );
    }
    return manager;
  }

  repo<T extends ObjectLiteral>(entity: EntityTarget<T>): Repository<T> {
    return this.manager.getRepository(entity);
  }

  query<T = unknown>(sql: string, parameters?: unknown[]): Promise<T> {
    return this.manager.query(sql, parameters) as Promise<T>;
  }

  /**
   * Escape hatch for genuinely cross-tenant work — the tenant registry itself,
   * health checks, and the scheduled jobs that iterate over every tenant.
   * Everything else must go through `manager`.
   */
  get unscoped(): DataSource {
    return this.dataSource;
  }
}
