import { Module } from '@nestjs/common';

import { VoucherInbox } from './entities/voucher-inbox.entity';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { VouchersModule } from '../vouchers/vouchers.module';
import { CollectionsModule } from '../collections/collections.module';
import { ErpSyncModule } from '../erp-sync/erp-sync.module';
import { SettingsModule } from '../settings/settings.module';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

@Module({
  imports: [
    TenantOrmModule.forFeature([VoucherInbox]),
    VouchersModule,
    CollectionsModule,
    ErpSyncModule,
    SettingsModule,
  ],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
