import { Module } from '@nestjs/common';

import { Rep } from './entities/rep.entity';
import { RepLocationEvent } from './entities/rep-location-event.entity';
import { RepStatus } from './entities/rep-status.entity';
import { RepsService } from './reps.service';
import { RepsController } from './reps.controller';
import { LocationsService } from './locations.service';
import { LocationsController } from './locations.controller';
import { RepStatusService } from './rep-status.service';
import { PartitionMaintenanceService } from './partition-maintenance.service';
import { ErpSyncModule } from '../erp-sync/erp-sync.module';
import { UsersModule } from '../users/users.module';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

@Module({
  imports: [
    TenantOrmModule.forFeature([Rep, RepLocationEvent, RepStatus]),
    ErpSyncModule,
    UsersModule,
  ],
  controllers: [RepsController, LocationsController],
  providers: [
    RepsService,
    LocationsService,
    RepStatusService,
    PartitionMaintenanceService,
  ],
  exports: [RepsService, LocationsService, RepStatusService],
})
export class RepsModule {}
