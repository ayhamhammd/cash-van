import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StockRequest } from './entities/stock-request.entity';
import { StockRequestItem } from './entities/stock-request-item.entity';
import { StockRequestsService } from './stock-requests.service';
import { StockRequestsController } from './stock-requests.controller';
import { Rep } from '../reps/entities/rep.entity';
import { User } from '../users/entities/user.entity';
import { Warehouse } from '../warehouses/entities/warehouse.entity';
import { ItemCart } from '../items/entities/item-cart.entity';
import { ItemUnit } from '../units/entities/item-unit.entity';
import { UsersModule } from '../users/users.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { VouchersModule } from '../vouchers/vouchers.module';
import { ErpSyncModule } from '../erp-sync/erp-sync.module';

@Module({
  imports: [
    UsersModule,
    TypeOrmModule.forFeature([StockRequest, StockRequestItem, Rep, User, Warehouse, ItemCart, ItemUnit]),
    // Receiving a request raises a TRANSFER voucher. Deferred for the same
    // reason ApprovalsModule defers it: Vouchers pulls in Customers, which
    // pulls in Approvals, and this module sits in that same graph.
    forwardRef(() => VouchersModule),
    // Approval queues the ERP push. Circular: erp-sync reads this module's
    // entity to build that payload.
    forwardRef(() => ErpSyncModule),
    NotificationsModule,
  ],
  controllers: [StockRequestsController],
  providers: [StockRequestsService],
  exports: [StockRequestsService],
})
export class StockRequestsModule {}
