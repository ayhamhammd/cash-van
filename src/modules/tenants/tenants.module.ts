import { Module } from '@nestjs/common';

import { InternalTenantsController } from './internal-tenants.controller';
import { InternalServiceController } from './internal-service.controller';
import { TenantsService } from './tenants.service';

@Module({
  controllers: [InternalTenantsController, InternalServiceController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
