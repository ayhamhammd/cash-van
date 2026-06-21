import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Rep } from './entities/rep.entity';
import { RepLocationEvent } from './entities/rep-location-event.entity';
import { RepsService } from './reps.service';
import { RepsController } from './reps.controller';
import { LocationsService } from './locations.service';
import { LocationsController } from './locations.controller';
import { PartitionMaintenanceService } from './partition-maintenance.service';
import { ErpSyncModule } from '../erp-sync/erp-sync.module';

@Module({
  imports: [TypeOrmModule.forFeature([Rep, RepLocationEvent]), ErpSyncModule],
  controllers: [RepsController, LocationsController],
  providers: [RepsService, LocationsService, PartitionMaintenanceService],
  exports: [RepsService, LocationsService],
})
export class RepsModule {}
