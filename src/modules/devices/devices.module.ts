import { Module } from '@nestjs/common';

import { UserDevice } from './entities/user-device.entity';
import { User } from '../users/entities/user.entity';
import { DevicesService } from './devices.service';
import { DevicesController } from './devices.controller';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

@Module({
  imports: [TenantOrmModule.forFeature([UserDevice, User])],
  controllers: [DevicesController],
  providers: [DevicesService],
  // Auth mints the binding at login; the tracking guard checks it per request.
  exports: [DevicesService],
})
export class DevicesModule {}
