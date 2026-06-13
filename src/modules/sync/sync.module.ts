import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { VoucherInbox } from './entities/voucher-inbox.entity';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { VouchersModule } from '../vouchers/vouchers.module';
import { CollectionsModule } from '../collections/collections.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([VoucherInbox]),
    VouchersModule,
    CollectionsModule,
  ],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
