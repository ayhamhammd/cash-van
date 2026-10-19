import { DynamicModule, Module, Provider } from '@nestjs/common';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { ClsService } from 'nestjs-cls';
import {
  DataSource,
  EntityManager,
  EntitySchema,
  EntityTarget,
  ObjectLiteral,
  Repository,
} from 'typeorm';

import { TENANT_EM_KEY } from './tenant-db.service';

/** Same shape `TypeOrmModule.forFeature` accepts. */
type FeatureEntity = Function | EntitySchema<ObjectLiteral>;

/**
 * Drop-in replacement for `TypeOrmModule.forFeature`, handing out repositories
 * that resolve to the CURRENT REQUEST'S transaction instead of an arbitrary
 * pooled connection.
 *
 * WHY THIS EXISTS
 * Row-level security filters on `app.tenant_id`, which is set per connection by
 * `TenantScope`. A repository built by the stock `forFeature` is bound at module
 * init to the DataSource's own manager, so it takes whichever connection the
 * pool hands it — one where `app.tenant_id` was never set, and where every
 * policy therefore matches nothing.
 *
 * Rewriting ~640 call sites to reach the right manager was the obvious fix and
 * a bad one: it is a large mechanical diff through the entire codebase, and any
 * site missed keeps compiling. Swapping the provider instead means every
 * existing `this.repo.find(...)` and `this.repo.query(...)` keeps working
 * verbatim and simply lands on the correct connection.
 *
 * Outside a request there is no tenant-bound manager, so this falls back to the
 * DataSource's manager. That is the honest behaviour: with no tenant set, RLS
 * returns nothing rather than someone else's rows.
 */
@Module({})
export class TenantOrmModule {
  static forFeature(
    entities: FeatureEntity[],
    dataSource?: string,
  ): DynamicModule {
    const providers: Provider[] = entities.map((entity) => ({
      provide: getRepositoryToken(entity, dataSource),
      inject: [ClsService, getDataSourceToken(dataSource)],
      useFactory: (cls: ClsService, ds: DataSource) =>
        tenantRepository(entity as EntityTarget<ObjectLiteral>, cls, ds),
    }));

    return {
      module: TenantOrmModule,
      providers,
      exports: providers,
    };
  }
}

/**
 * A Repository-shaped proxy that re-resolves its target on every property
 * access. The indirection has to be per-access, not per-injection: the same
 * injected instance is shared across concurrent requests belonging to different
 * tenants.
 */
export function tenantRepository<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
  cls: ClsService,
  dataSource: DataSource,
): Repository<T> {
  const resolve = (): Repository<T> => {
    const manager = cls.get<EntityManager | undefined>(TENANT_EM_KEY);
    return (manager ?? dataSource.manager).getRepository(entity);
  };

  return new Proxy({} as Repository<T>, {
    get(_target, prop, receiver) {
      const repo = resolve();
      const value = Reflect.get(repo, prop, receiver);
      // Methods must keep the real repository as `this`; TypeORM reads
      // `this.manager` and `this.metadata` on almost every call.
      return typeof value === 'function' ? value.bind(repo) : value;
    },
    set(_target, prop, value) {
      return Reflect.set(resolve(), prop, value);
    },
    has(_target, prop) {
      return prop in resolve();
    },
    // Keeps `instanceof Repository` true for code that checks.
    getPrototypeOf() {
      return Repository.prototype;
    },
  });
}
