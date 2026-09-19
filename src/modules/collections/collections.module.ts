import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Collection } from './entities/collection.entity';
import { Cheque } from './entities/cheque.entity';
import { Rep } from '../reps/entities/rep.entity';
import { Customer } from '../customers/entities/customer.entity';
import { CustomersModule } from '../customers/customers.module';
import { UsersModule } from '../users/users.module';
import { ErpSyncModule } from '../erp-sync/erp-sync.module';

import { CollectionsService } from './collections.service';
import { ChequesService } from './cheques.service';
import { CollectionsController } from './collections.controller';
import { ChequesController } from './cheques.controller';
import { ReferenceController } from './reference.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Collection, Cheque, Rep, Customer]),
    CustomersModule,
    UsersModule,
    // For the cheque re-entry path: completing a cheque's details has to be able
    // to push its receipt again. ErpSyncModule pulls in no collections provider,
    // so this direction does not close a cycle.
    ErpSyncModule,
  ],
  controllers: [CollectionsController, ChequesController, ReferenceController],
  providers: [CollectionsService, ChequesService],
  exports: [CollectionsService, ChequesService],
})
export class CollectionsModule {}
