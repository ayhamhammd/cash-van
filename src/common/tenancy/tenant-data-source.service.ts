import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ClsService } from 'nestjs-cls';
import {
  DataSource,
  EntityManager,
  EntityTarget,
  ObjectLiteral,
  Repository,
} from 'typeorm';

import { TENANT_EM_KEY } from './tenant-db.service';

/**
 * Drop-in replacement for an injected `DataSource` in request-handling code.
 *
 * Services that inject the DataSource directly reach the database through a
 * connection of their own choosing. That connection never had `app.tenant_id`
 * set on it, so every row-level security policy matches nothing and the query
 * quietly returns empty. This exposes the same four members those services
 * actually use — `query`, `transaction`, `getRepository`, `manager` — but
 * resolved against the current request's transaction.
 *
 * Outside a request it falls back to the raw DataSource, which is what the
 * partition-maintenance and other cross-tenant jobs need.
 */
@Injectable()
export class TenantDataSource {
  constructor(
    private readonly cls: ClsService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** The request's transaction manager, or the plain one outside a request. */
  get manager(): EntityManager {
    return (
      this.cls.get<EntityManager | undefined>(TENANT_EM_KEY) ??
      this.dataSource.manager
    );
  }

  // Mirrors TypeORM's own `query<T = any>` on purpose. This is a drop-in for an
  // injected DataSource, and narrowing the default to `unknown` would force a
  // cast at every one of the ~60 existing raw-SQL call sites for no safety gain
  // — the rows are untyped either way.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = any>(sql: string, parameters?: unknown[]): Promise<T> {
    return this.manager.query(sql, parameters) as Promise<T>;
  }

  getRepository<T extends ObjectLiteral>(
    entity: EntityTarget<T>,
  ): Repository<T> {
    return this.manager.getRepository(entity);
  }

  /**
   * Runs `fn` atomically.
   *
   * Inside a request there is already a transaction — the one holding this
   * tenant's `app.tenant_id` — so the callback joins it rather than opening a
   * second one. Opening a nested transaction would take a DIFFERENT pooled
   * connection with no tenant set, which is precisely the bug this class
   * exists to prevent. Joining is also the stronger guarantee: the work is
   * still atomic, and now atomic with the rest of the request.
   */
  async transaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    const scoped = this.cls.get<EntityManager | undefined>(TENANT_EM_KEY);
    if (scoped) return fn(scoped);
    return this.dataSource.transaction(fn);
  }

  /** Genuinely cross-tenant work only — see TenantDb.unscoped. */
  get unscoped(): DataSource {
    return this.dataSource;
  }
}
