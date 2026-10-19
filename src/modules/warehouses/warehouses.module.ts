import { Module } from '@nestjs/common';

import { Warehouse } from './entities/warehouse.entity';
import { WarehousesService } from './warehouses.service';
import { WarehousesController } from './warehouses.controller';
import { UsersModule } from '../users/users.module';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

@Module({
  imports: [TenantOrmModule.forFeature([Warehouse]), UsersModule],
  controllers: [WarehousesController],
  providers: [WarehousesService],
  exports: [WarehousesService, TenantOrmModule],
})
export class WarehousesModule {}
