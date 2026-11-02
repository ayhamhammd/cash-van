import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SalesTarget } from './entities/sales-target.entity';
import { TargetsService } from './targets.service';
import { TargetsController } from './targets.controller';
import { ErpSyncModule } from '../erp-sync/erp-sync.module';

/** Per-salesman monthly sales targets (on sale amount or qty) + actuals. */
@Module({
  imports: [
    UsersModule, ErpSyncModule, TypeOrmModule.forFeature([SalesTarget])],
  controllers: [TargetsController],
  providers: [TargetsService],
})
export class TargetsModule {}
