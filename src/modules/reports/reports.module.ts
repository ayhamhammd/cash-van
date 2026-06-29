import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ErpSyncModule } from '../erp-sync/erp-sync.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SalesmanSettlement } from './entities/salesman-settlement.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SalesmanSettlement]), ErpSyncModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
