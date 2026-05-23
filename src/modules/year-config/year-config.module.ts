import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { YearConfig } from './entities/year-config.entity';
import { YearConfigService } from './year-config.service';
import { YearConfigController } from './year-config.controller';

@Module({
  imports: [TypeOrmModule.forFeature([YearConfig])],
  controllers: [YearConfigController],
  providers: [YearConfigService],
  exports: [YearConfigService],
})
export class YearConfigModule {}
