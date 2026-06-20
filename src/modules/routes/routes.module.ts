import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RoutePlan } from './entities/route-plan.entity';
import { RouteStop } from './entities/route-stop.entity';
import { JourneyPlanEntry } from './entities/journey-plan-entry.entity';
import { Rep } from '../reps/entities/rep.entity';
import { Customer } from '../customers/entities/customer.entity';

import { RoutesService } from './routes.service';
import { JourneyPlanService } from './journey-plan.service';
import { RouteAdherenceService } from './route-adherence.service';
import { RoutesController } from './routes.controller';
import { JourneyPlanController } from './journey-plan.controller';
import { MyRouteController } from './my-route.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RoutePlan,
      RouteStop,
      JourneyPlanEntry,
      Rep,
      Customer,
    ]),
  ],
  controllers: [RoutesController, JourneyPlanController, MyRouteController],
  providers: [RoutesService, JourneyPlanService, RouteAdherenceService],
  exports: [RoutesService, JourneyPlanService, RouteAdherenceService],
})
export class RoutesModule {}
