import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Customer } from '../customers/entities/customer.entity';
import { CustomerArea } from './entities/customer-area.entity';
import { AreasController } from './areas.controller';
import { AreasService } from './areas.service';

@Module({
  imports: [TypeOrmModule.forFeature([CustomerArea, Customer])],
  controllers: [AreasController],
  providers: [AreasService],
  exports: [AreasService],
})
export class AreasModule {}
