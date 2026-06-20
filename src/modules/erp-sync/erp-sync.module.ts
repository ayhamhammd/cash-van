import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ItemCart } from '../items/entities/item-cart.entity';
import { VoucherHeader } from '../vouchers/entities/voucher-header.entity';
import { VoucherTransaction } from '../vouchers/entities/voucher-transaction.entity';
import { SettingsModule } from '../settings/settings.module';
import { ErpHttpClient } from './erp-http.client';
import { ErpSyncService } from './erp-sync.service';
import { ErpOutboxService } from './erp-outbox.service';
import { ErpSyncController } from './erp-sync.controller';
import { ErpIdMap } from './entities/erp-id-map.entity';
import { ErpSyncCursor } from './entities/erp-sync-cursor.entity';
import { ErpOutbox } from './entities/erp-outbox.entity';

/** ERP (erp-saas) integration — inbound catalog pull + outbound van-txn push. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ItemCart,
      ErpIdMap,
      ErpSyncCursor,
      ErpOutbox,
      VoucherHeader,
      VoucherTransaction,
    ]),
    SettingsModule,
  ],
  controllers: [ErpSyncController],
  providers: [ErpHttpClient, ErpSyncService, ErpOutboxService],
  exports: [ErpSyncService, ErpOutboxService],
})
export class ErpSyncModule {}
