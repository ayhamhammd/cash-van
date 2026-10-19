import { Module } from '@nestjs/common';

import { RoutePlan } from './entities/route-plan.entity';
import { RouteStop } from './entities/route-stop.entity';
import { JourneyPlanEntry } from './entities/journey-plan-entry.entity';
import { Rep } from '../reps/entities/rep.entity';
import { Customer } from '../customers/entities/customer.entity';
import { CustomerVisit } from '../customers/entities/customer-visit.entity';

import { RoutesService } from './routes.service';
import { JourneyPlanService } from './journey-plan.service';
import { RouteAdherenceService } from './route-adherence.service';
import { RoutesController } from './routes.controller';
import { JourneyPlanController } from './journey-plan.controller';
import { MyRouteController } from './my-route.controller';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

@Module({
  imports: [
    TenantOrmModule.forFeature([
      RoutePlan,
      RouteStop,
      JourneyPlanEntry,
      Rep,
      Customer,
      CustomerVisit,
    ]),
  ],
  controllers: [RoutesController, JourneyPlanController, MyRouteController],
  providers: [RoutesService, JourneyPlanService, RouteAdherenceService],
  exports: [RoutesService, JourneyPlanService, RouteAdherenceService],
})
export class RoutesModule {}
