import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CustomerSegment } from './entities/customer-segment.entity';
import { SegmentCustomer } from './entities/segment-customer.entity';
import { SegmentRep } from './entities/segment-rep.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Rep } from '../reps/entities/rep.entity';
import { UsersModule } from '../users/users.module';
import { SegmentsService } from './segments.service';
import { SegmentsController } from './segments.controller';

/**
 * Customer segmentation — the reusable "these customers" primitive. Registers the
 * segment + membership tables and read-only access to customers (to resolve
 * numbers→ids and list members). Imports UsersModule for RepScopeService so
 * member listings respect a supervisor's rep scope. Exports the service so later
 * phases (offers targeting, analytics) can resolve membership without the HTTP layer.
 */
@Module({
  imports: [
    UsersModule,
    TypeOrmModule.forFeature([
      CustomerSegment,
      SegmentCustomer,
      SegmentRep,
      Customer,
      Rep,
    ]),
  ],
  controllers: [SegmentsController],
  providers: [SegmentsService],
  exports: [SegmentsService],
})
export class SegmentsModule {}
