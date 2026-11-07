import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ErpSyncModule } from '../erp-sync/erp-sync.module';
import { ErpSyncCursor } from '../erp-sync/entities/erp-sync-cursor.entity';
import { Rep } from '../reps/entities/rep.entity';
import { SettingsModule } from '../settings/settings.module';
import { DeliveriesAppController, DeliverySyncController } from './deliveries-app.controller';
import { DeliveriesController } from './deliveries.controller';
import { DeliveriesService } from './deliveries.service';
import { DeliveryErpClient } from './delivery-erp.client';
import { DeliveryIntakeService } from './delivery-intake.service';
import { DeliveryMirrorService } from './delivery-mirror.service';
import { DeliveryRun } from './entities/delivery-run.entity';
import { DeliveryStop } from './entities/delivery-stop.entity';
import { DeliveryStopLine } from './entities/delivery-stop-line.entity';

/**
 * Delivery & collection representative, phase 1 (docs/SPEC-delivery-rep.md):
 * the mirror of the ERP's delivery runs, the office's run screens, the delivery
 * rep's phone routes and his whole-invoice results.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([DeliveryRun, DeliveryStop, DeliveryStopLine, Rep, ErpSyncCursor]),
    ErpSyncModule,
    SettingsModule,
  ],
  controllers: [DeliveriesController, DeliveriesAppController, DeliverySyncController],
  providers: [DeliveryErpClient, DeliveryMirrorService, DeliveriesService, DeliveryIntakeService],
  exports: [DeliveriesService, DeliveryMirrorService],
})
export class DeliveriesModule {}
