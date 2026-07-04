import { Module, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Customer } from './entities/customer.entity';
import { CustomerAiProfile } from './entities/customer-ai-profile.entity';
import { CustomerVisit } from './entities/customer-visit.entity';
import { CustomerAttachment } from './entities/customer-attachment.entity';
import {
  AI_PROFILE_REFRESH_QUEUE,
  CustomersService,
} from './customers.service';
import { CustomersController } from './customers.controller';
import { JobsService } from '../../common/jobs/jobs.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Customer,
      CustomerAiProfile,
      CustomerVisit,
      CustomerAttachment,
    ]),
  ],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService, TypeOrmModule],
})
export class CustomersModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(CustomersModule.name);

  constructor(private readonly jobs: JobsService) {}

  async onApplicationBootstrap(): Promise<void> {
    // Placeholder worker. Real AI-profile computation lands in plan 08;
    // for now it just acknowledges the job so the queue drains.
    await this.jobs.register<{ customerId: string }>(
      AI_PROFILE_REFRESH_QUEUE,
      async (data) => {
        this.logger.log(
          `AI-profile refresh requested for customer ${data.customerId} (stub — implemented in plan 08)`,
        );
      },
    );
  }
}
