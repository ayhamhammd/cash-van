import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CustomerArea } from '../areas/entities/customer-area.entity';
import { Customer } from '../customers/entities/customer.entity';
import { SettingsModule } from '../settings/settings.module';
import { Location } from './entities/location.entity';
import { LocationTreeController } from './locations.controller';
import { LocationTreeService } from './locations.service';

@Module({
  imports: [TypeOrmModule.forFeature([Location, Customer, CustomerArea]), SettingsModule],
  controllers: [LocationTreeController],
  providers: [LocationTreeService],
  exports: [LocationTreeService],
})
export class LocationTreeModule {}
