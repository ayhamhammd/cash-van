import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsGateway } from './events.gateway';
import { EventBridgeService } from './event-bridge.service';
import { HeartbeatWatchdogService } from './heartbeat-watchdog.service';
import { Rep } from '../modules/reps/entities/rep.entity';
import { RepStatus } from '../modules/reps/entities/rep-status.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Rep, RepStatus]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwt.secret'),
      }),
    }),
  ],
  providers: [EventsGateway, EventBridgeService, HeartbeatWatchdogService],
  exports: [EventsGateway],
})
export class RealtimeModule {}
