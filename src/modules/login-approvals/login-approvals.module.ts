import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TrustedDevice } from './entities/trusted-device.entity';
import { LoginRequest } from './entities/login-request.entity';
import { LoginApprovalsService } from './login-approvals.service';
import { LoginApprovalsController } from './login-approvals.controller';
import { User } from '../users/entities/user.entity';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [TypeOrmModule.forFeature([TrustedDevice, LoginRequest, User]), SettingsModule, NotificationsModule],
  controllers: [LoginApprovalsController],
  providers: [LoginApprovalsService],
  // Auth runs the gate at sign-in.
  exports: [LoginApprovalsService],
})
export class LoginApprovalsModule {}
