import { Module } from '@nestjs/common';

import { Invoice } from './entities/invoice.entity';
import { InvoiceLine } from './entities/invoice-line.entity';
import { InvoiceApproval } from './entities/invoice-approval.entity';
import { Rep } from '../reps/entities/rep.entity';
import { Customer } from '../customers/entities/customer.entity';
import { ItemCart } from '../items/entities/item-cart.entity';

import { InvoicesService } from './invoices.service';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoicesController } from './invoices.controller';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

@Module({
  imports: [
    TenantOrmModule.forFeature([
      Invoice,
      InvoiceLine,
      InvoiceApproval,
      Rep,
      Customer,
      ItemCart,
    ]),
  ],
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoiceNumberService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
