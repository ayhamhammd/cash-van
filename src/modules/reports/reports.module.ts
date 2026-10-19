import { Module } from '@nestjs/common';

import { ErpSyncModule } from '../erp-sync/erp-sync.module';
import { CashAccountsModule } from '../cash-accounts/cash-accounts.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SalesmanSettlement } from './entities/salesman-settlement.entity';
import { UsersModule } from '../users/users.module';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

@Module({
  imports: [UsersModule, TenantOrmModule.forFeature([SalesmanSettlement]), ErpSyncModule, CashAccountsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
