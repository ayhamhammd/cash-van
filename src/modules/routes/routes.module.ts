import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RoutePlan } from './entities/route-plan.entity';
import { RouteStop } from './entities/route-stop.entity';
import { Rep } from '../reps/entities/rep.entity';
import { Customer } from '../customers/entities/customer.entity';

import { RoutesService } from './routes.service';
import { RouteAdherenceService } from './route-adherence.service';
import { RoutesController } from './routes.controller';

@Module({
  imports: [TypeOrmModule.forFeature([RoutePlan, RouteStop, Rep, Customer])],
  controllers: [RoutesController],
  providers: [RoutesService, RouteAdherenceService],
  exports: [RoutesService, RouteAdherenceService],
})
export class RoutesModule {}
