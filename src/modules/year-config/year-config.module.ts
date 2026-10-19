import { Module } from '@nestjs/common';

import { YearConfig } from './entities/year-config.entity';
import { YearConfigService } from './year-config.service';
import { YearConfigController } from './year-config.controller';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

@Module({
  imports: [TenantOrmModule.forFeature([YearConfig])],
  controllers: [YearConfigController],
  providers: [YearConfigService],
  exports: [YearConfigService],
})
export class YearConfigModule {}
