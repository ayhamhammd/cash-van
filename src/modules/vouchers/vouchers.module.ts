import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { VoucherHeader } from './entities/voucher-header.entity';
import { VoucherTransaction } from './entities/voucher-transaction.entity';
import { Payment } from './entities/payment.entity';
import { PaymentCheque } from './entities/payment-cheque.entity';
import { TransactionKind } from './entities/transaction-kind.entity';

import { VouchersService } from './vouchers.service';
import { TransactionKindsService } from './transaction-kinds.service';
import { VouchersController } from './vouchers.controller';

import { ItemsModule } from '../items/items.module';
import { UsersModule } from '../users/users.module';
import { CustomersModule } from '../customers/customers.module';
import { VendorsModule } from '../vendors/vendors.module';
import { WarehousesModule } from '../warehouses/warehouses.module';
import { OffersModule } from '../offers/offers.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      VoucherHeader,
      VoucherTransaction,
      Payment,
      PaymentCheque,
      TransactionKind,
    ]),
    ItemsModule,
    UsersModule,
    CustomersModule,
    VendorsModule,
    WarehousesModule,
    OffersModule,
  ],
  controllers: [VouchersController],
  providers: [VouchersService, TransactionKindsService],
  exports: [VouchersService, TransactionKindsService],
})
export class VouchersModule {}
