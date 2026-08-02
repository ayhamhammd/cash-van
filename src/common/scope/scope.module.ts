import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Rep } from '../../modules/reps/entities/rep.entity';
import { SupervisorRep } from '../../modules/users/entities/supervisor-rep.entity';
import { ScopeService } from './scope.service';

/**
 * Global so any module can filter by scope without wiring an import — the
 * alternative is 17 modules each remembering to import it, and the one that
 * forgets is a leak rather than a compile error.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([SupervisorRep, Rep])],
  providers: [ScopeService],
  exports: [ScopeService],
})
export class ScopeModule {}
