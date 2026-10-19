import { Module } from '@nestjs/common';

import { Region } from './entities/region.entity';
import { RegionsService } from './regions.service';
import { RegionsController } from './regions.controller';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

@Module({
  imports: [TenantOrmModule.forFeature([Region])],
  controllers: [RegionsController],
  providers: [RegionsService],
  exports: [RegionsService],
})
export class RegionsModule {}
