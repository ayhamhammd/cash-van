import { Global, Module } from '@nestjs/common';

import { RlsEnforcementService } from './rls-enforcement.service';
import { TenantCounters } from './tenant-counters.service';
import { TenantDataSource } from './tenant-data-source.service';
import { TenantDb } from './tenant-db.service';
import { TenantScope } from './tenant-scope.service';

/**
 * Tenant plumbing. Global because `TenantDb` replaces `@InjectRepository`
 * across every feature module, and threading an import into all of them would
 * be noise.
 */
@Global()
@Module({
  providers: [TenantDb, TenantDataSource, TenantCounters, TenantScope, RlsEnforcementService],
  exports: [TenantDb, TenantDataSource, TenantCounters, TenantScope],
})
export class TenancyModule {}
