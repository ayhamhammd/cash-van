import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ErpSyncModule } from '../erp-sync/erp-sync.module';
import { ErpSyncCursor } from '../erp-sync/entities/erp-sync-cursor.entity';
import { ErpSyncService } from '../erp-sync/erp-sync.service';
import { Rep } from '../reps/entities/rep.entity';
import { SettingsModule } from '../settings/settings.module';
import { DeliveriesAppController, DeliverySyncController } from './deliveries-app.controller';
import { DeliveriesController } from './deliveries.controller';
import { DeliveriesService } from './deliveries.service';
import { DeliveryErpClient } from './delivery-erp.client';
import { DeliveryIntakeService } from './delivery-intake.service';
import { DELIVERY_CURSOR, DeliveryMirrorService } from './delivery-mirror.service';
import { DeliveryRun } from './entities/delivery-run.entity';
import { DeliveryStop } from './entities/delivery-stop.entity';
import { DeliveryStopLine } from './entities/delivery-stop-line.entity';
import { DeliveryProof } from './entities/delivery-proof.entity';
import { DeliveryProofsService } from './delivery-proofs.service';
import { DeliveryReturnsService } from './delivery-returns.service';
import { DeliveryIncreasesService } from './delivery-increases.service';
import { DeliveryReturnVoucherService } from './delivery-return-voucher.service';
import { DeliveryFeatureGuard } from './delivery-feature.guard';
import { DeliveryIncreaseRequest } from './entities/delivery-increase-request.entity';
import { VouchersModule } from '../vouchers/vouchers.module';
import { ProductsModule } from '../products/products.module';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Delivery & collection representative (docs/SPEC-delivery-rep.md): the mirror
 * of the ERP's delivery runs, the office's run screens, the delivery rep's phone
 * routes, his results line by line and his proofs, and the office's return
 * approvals through the ERP, and increase requests turned into orders (phases 1–4).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DeliveryRun,
      DeliveryStop,
      DeliveryStopLine,
      DeliveryProof,
      DeliveryIncreaseRequest,
      Rep,
      ErpSyncCursor,
    ]),
    ErpSyncModule,
    SettingsModule,
    NotificationsModule,
    VouchersModule,
    ProductsModule,
  ],
  controllers: [DeliveriesController, DeliveriesAppController, DeliverySyncController],
  providers: [
    DeliveryErpClient,
    DeliveryMirrorService,
    DeliveriesService,
    DeliveryIntakeService,
    DeliveryProofsService,
    DeliveryReturnsService,
    DeliveryIncreasesService,
    DeliveryReturnVoucherService,
    DeliveryFeatureGuard,
  ],
  exports: [DeliveriesService, DeliveryMirrorService],
})
export class DeliveriesModule implements OnModuleInit {
  constructor(
    private readonly erpSync: ErpSyncService,
    private readonly mirror: DeliveryMirrorService,
  ) {}

  /** The ERP sync table's "run" button on the delivery_runs row starts this pull. */
  onModuleInit(): void {
    this.erpSync.registerRunner(DELIVERY_CURSOR, 'fast', () => this.mirror.pullDeliveryRuns());
  }
}
