import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';

import { Customer } from '../customers/entities/customer.entity';
import { Rep } from '../reps/entities/rep.entity';
import { ErpIdMap } from '../erp-sync/entities/erp-id-map.entity';
import { ErpSyncModule } from '../erp-sync/erp-sync.module';
import { ArController } from './ar.controller';
import { ArService } from './ar.service';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

/**
 * Accounts receivable (debt / ذمم). Read-only AR API: balance + aging proxied from the
 * ERP (source of truth), arrears widget computed from mirrored data.
 * See docs/SPEC-accounts-receivable.md.
 */
@Module({
  imports: [
    UsersModule,
    TenantOrmModule.forFeature([Customer, Rep, ErpIdMap]),
    ErpSyncModule, // provides ErpHttpClient
  ],
  controllers: [ArController],
  providers: [ArService],
  exports: [ArService],
})
export class ArModule {}
