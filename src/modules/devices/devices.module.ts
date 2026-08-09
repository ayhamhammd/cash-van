import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserDevice } from './entities/user-device.entity';
import { User } from '../users/entities/user.entity';
import { DevicesService } from './devices.service';
import { DevicesController } from './devices.controller';

@Module({
  imports: [TypeOrmModule.forFeature([UserDevice, User])],
  controllers: [DevicesController],
  providers: [DevicesService],
  // Auth mints the binding at login; the tracking guard checks it per request.
  exports: [DevicesService],
})
export class DevicesModule {}
