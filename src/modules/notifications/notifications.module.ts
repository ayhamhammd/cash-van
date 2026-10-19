import { Module } from '@nestjs/common';

import { AppNotification } from './entities/notification.entity';
import { User } from '../users/entities/user.entity';
import { Rep } from '../reps/entities/rep.entity';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { RepStatusAlertsListener } from './rep-status-alerts.listener';
import { TenantOrmModule } from '../../common/tenancy/tenant-orm.module';

@Module({
  imports: [TenantOrmModule.forFeature([AppNotification, User, Rep])],
  controllers: [NotificationsController],
  providers: [NotificationsService, RepStatusAlertsListener],
  exports: [NotificationsService],
})
export class NotificationsModule {}
