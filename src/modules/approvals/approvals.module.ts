import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApprovalRequest } from './entities/approval-request.entity';
import { Rep } from '../reps/entities/rep.entity';
import { User } from '../users/entities/user.entity';
import { CustomersModule } from '../customers/customers.module';
import { PendingCustomerPhoto } from '../customers/entities/pending-customer-photo.entity';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController } from './approvals.controller';
import { VouchersModule } from '../vouchers/vouchers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    UsersModule,
    TypeOrmModule.forFeature([ApprovalRequest, Rep, User, PendingCustomerPhoto]),
    // Approving a CUSTOMER_CREATE request creates the customer; CustomersModule
    // files those requests. Circular by nature, so forwardRef on both sides.
    forwardRef(() => CustomersModule),
    // Also deferred: adding CustomersModule above closed a NEW cycle
    // (Vouchers → Customers → Approvals → Vouchers), so by the time this array
    // is evaluated VouchersModule is still undefined and Nest fails to boot.
    forwardRef(() => VouchersModule),
    NotificationsModule,
  ],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
