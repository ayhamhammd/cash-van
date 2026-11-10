import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SalesTarget } from './entities/sales-target.entity';
import { SalesItemTarget } from './entities/sales-item-target.entity';
import { ItemTargetsService } from './item-targets.service';
import { SettingsModule } from '../settings/settings.module';
import { TargetsService } from './targets.service';
import { TargetsController } from './targets.controller';
import { ErpSyncModule } from '../erp-sync/erp-sync.module';

/** Per-salesman monthly sales targets (on sale amount or qty) + actuals. */
@Module({
  imports: [
    UsersModule, ErpSyncModule, SettingsModule, TypeOrmModule.forFeature([SalesTarget, SalesItemTarget])],
  controllers: [TargetsController],
  providers: [TargetsService, ItemTargetsService],
})
export class TargetsModule {}
