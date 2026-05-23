import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Collection } from './entities/collection.entity';
import { Cheque } from './entities/cheque.entity';
import { Rep } from '../reps/entities/rep.entity';
import { Customer } from '../customers/entities/customer.entity';

import { CollectionsService } from './collections.service';
import { ChequesService } from './cheques.service';
import { CollectionsController } from './collections.controller';
import { ChequesController } from './cheques.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Collection, Cheque, Rep, Customer])],
  controllers: [CollectionsController, ChequesController],
  providers: [CollectionsService, ChequesService],
  exports: [CollectionsService, ChequesService],
})
export class CollectionsModule {}
