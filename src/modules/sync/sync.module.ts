import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { VoucherInbox } from './entities/voucher-inbox.entity';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { SyncInboxDrainService } from './sync-inbox-drain.service';
import { VouchersModule } from '../vouchers/vouchers.module';
import { CollectionsModule } from '../collections/collections.module';
import { ErpSyncModule } from '../erp-sync/erp-sync.module';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([VoucherInbox]),
    VouchersModule,
    CollectionsModule,
    ErpSyncModule,
    SettingsModule,
    // A rejected or dead-lettered document is announced rather than left in a
    // queue nobody visits.
    NotificationsModule,
  ],
  controllers: [SyncController],
  providers: [SyncService, SyncInboxDrainService],
  exports: [SyncService],
})
export class SyncModule {}
