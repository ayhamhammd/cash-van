import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { InvoiceTemplate } from './entities/invoice-template.entity';
import { InvoiceTemplatesService } from './invoice-templates.service';
import { InvoiceTemplatesController } from './invoice-templates.controller';

@Module({
  imports: [TypeOrmModule.forFeature([InvoiceTemplate])],
  controllers: [InvoiceTemplatesController],
  providers: [InvoiceTemplatesService],
  exports: [InvoiceTemplatesService],
})
export class InvoiceTemplatesModule {}
