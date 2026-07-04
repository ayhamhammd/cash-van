import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppNotification } from './entities/notification.entity';
import { User } from '../users/entities/user.entity';
import { Rep } from '../reps/entities/rep.entity';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { RepStatusAlertsListener } from './rep-status-alerts.listener';

@Module({
  imports: [TypeOrmModule.forFeature([AppNotification, User, Rep])],
  controllers: [NotificationsController],
  providers: [NotificationsService, RepStatusAlertsListener],
  exports: [NotificationsService],
})
export class NotificationsModule {}
