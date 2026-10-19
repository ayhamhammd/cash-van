import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AuditLog } from './entities/audit-log.entity';
import { NotificationRule } from './entities/notification-rule.entity';

import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { AuditPartitionService } from './audit-partition.service';
import { AuditInterceptor } from '../../common/interceptors/audit.interceptor';

import { NotificationDispatcher } from './notification-dispatcher.service';
import { RuleEvaluator } from './rule-evaluator.service';
import { NotificationRulesService } from './notification-rules.service';
import { NotificationRulesController } from './notification-rules.controller';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

@Module({
  imports: [TenantOrmModule.forFeature([AuditLog, NotificationRule])],
  controllers: [AuditController, NotificationRulesController],
  providers: [
    AuditService,
    AuditPartitionService,
    NotificationDispatcher,
    RuleEvaluator,
    NotificationRulesService,
    // Global audit interceptor — records every mutating request.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService, NotificationDispatcher, RuleEvaluator],
})
export class SystemModule {}
