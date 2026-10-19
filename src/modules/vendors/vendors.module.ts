import { Module } from '@nestjs/common';

import { Vendor } from './entities/vendor.entity';
import { VendorsService } from './vendors.service';
import { VendorsController } from './vendors.controller';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

@Module({
  imports: [TenantOrmModule.forFeature([Vendor])],
  controllers: [VendorsController],
  providers: [VendorsService],
  exports: [VendorsService, TenantOrmModule],
})
export class VendorsModule {}
