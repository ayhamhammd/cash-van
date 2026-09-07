import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { InvoiceTemplate } from './entities/invoice-template.entity';
import { Warehouse } from '../warehouses/entities/warehouse.entity';
import { Rep } from '../reps/entities/rep.entity';
import { InvoiceTemplatesService } from './invoice-templates.service';
import { InvoiceTemplatesController } from './invoice-templates.controller';

@Module({
  // Warehouse: `resolve` accepts a storeNumber (whNumber) and looks the id up.
  imports: [TypeOrmModule.forFeature([InvoiceTemplate, Warehouse, Rep])],
  controllers: [InvoiceTemplatesController],
  providers: [InvoiceTemplatesService],
  exports: [InvoiceTemplatesService],
})
export class InvoiceTemplatesModule {}
