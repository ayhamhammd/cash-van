import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ItemCart } from '../items/entities/item-cart.entity';
import { TobaccoTaxProfile } from '../items/entities/tobacco-tax-profile.entity';
import { Warehouse } from '../warehouses/entities/warehouse.entity';
import { Rep } from '../reps/entities/rep.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Unit } from '../units/entities/unit.entity';
import { ItemUnit } from '../units/entities/item-unit.entity';
import { ProductCategory } from '../products/entities/product-category.entity';
import { Collection } from '../collections/entities/collection.entity';
import { VoucherHeader } from '../vouchers/entities/voucher-header.entity';
import { VoucherTransaction } from '../vouchers/entities/voucher-transaction.entity';
import { SalesmanSettlement } from '../reports/entities/salesman-settlement.entity';
import { SettingsModule } from '../settings/settings.module';
import { VouchersModule } from '../vouchers/vouchers.module';
import { ErpHttpClient } from './erp-http.client';
import { HubHttpClient } from './hub-http.client';
import { HubWebhookService } from './hub-webhook.service';
import { HubWebhookController } from './hub-webhook.controller';
import { ErpSyncService } from './erp-sync.service';
import { ErpOutboxService } from './erp-outbox.service';
import { ErpSyncController } from './erp-sync.controller';
import { ErpIdMap } from './entities/erp-id-map.entity';
import { ErpSyncCursor } from './entities/erp-sync-cursor.entity';
import { ErpOutbox } from './entities/erp-outbox.entity';
import { HubWebhookEvent } from './entities/hub-webhook-event.entity';

/** ERP (erp-saas) integration — inbound catalog pull + outbound van-txn push. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ItemCart,
      TobaccoTaxProfile,
      Warehouse,
      Rep,
      Customer,
      Unit,
      ItemUnit,
      ProductCategory,
      Collection,
      ErpIdMap,
      ErpSyncCursor,
      ErpOutbox,
      HubWebhookEvent,
      VoucherHeader,
      VoucherTransaction,
      SalesmanSettlement,
    ]),
    SettingsModule,
    VouchersModule,
  ],
  controllers: [ErpSyncController, HubWebhookController],
  providers: [ErpHttpClient, HubHttpClient, HubWebhookService, ErpSyncService, ErpOutboxService],
  exports: [ErpSyncService, ErpOutboxService],
})
export class ErpSyncModule {}
