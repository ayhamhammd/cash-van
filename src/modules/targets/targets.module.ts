import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SalesTarget } from './entities/sales-target.entity';
import { TargetsService } from './targets.service';
import { TargetsController } from './targets.controller';

/** Per-salesman monthly sales targets (on sale amount or qty) + actuals. */
@Module({
  imports: [TypeOrmModule.forFeature([SalesTarget])],
  controllers: [TargetsController],
  providers: [TargetsService],
})
export class TargetsModule {}
