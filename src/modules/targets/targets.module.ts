import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';

import { SalesTarget } from './entities/sales-target.entity';
import { TargetsService } from './targets.service';
import { TargetsController } from './targets.controller';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

/** Per-salesman monthly sales targets (on sale amount or qty) + actuals. */
@Module({
  imports: [
    UsersModule,TenantOrmModule.forFeature([SalesTarget])],
  controllers: [TargetsController],
  providers: [TargetsService],
})
export class TargetsModule {}
