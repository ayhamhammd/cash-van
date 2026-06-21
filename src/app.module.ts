import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_GUARD } from '@nestjs/core';

import configuration from './config/configuration';
import { envValidationSchema } from './config/validation.schema';
import { typeOrmAsyncConfig } from './config/database.config';

import { HealthController } from './health/health.controller';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';

import { UserContextModule } from './common/context/user-context.module';
import { StorageModule } from './common/storage/storage.module';
import { CacheModule } from './common/cache/cache.module';
import { JobsModule } from './common/jobs/jobs.module';

import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { CustomersModule } from './modules/customers/customers.module';
import { VendorsModule } from './modules/vendors/vendors.module';
import { WarehousesModule } from './modules/warehouses/warehouses.module';
import { ItemsModule } from './modules/items/items.module';
import { VouchersModule } from './modules/vouchers/vouchers.module';
import { ReportsModule } from './modules/reports/reports.module';
import { YearConfigModule } from './modules/year-config/year-config.module';
import { RepsModule } from './modules/reps/reps.module';
import { SettingsModule } from './modules/settings/settings.module';
import { RegionsModule } from './modules/regions/regions.module';
import { ProductsModule } from './modules/products/products.module';
import { RoutesModule } from './modules/routes/routes.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { CollectionsModule } from './modules/collections/collections.module';
import { SystemModule } from './modules/system/system.module';
import { RealtimeModule } from './realtime/realtime.module';
import { TaxModule } from './modules/tax/tax.module';
import { MobileModule } from './modules/mobile/mobile.module';
import { UnitsModule } from './modules/units/units.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { AgentModule } from './modules/agent/agent.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: config.get<number>('rateLimit.ttl', 60) * 1000,
          limit: config.get<number>('rateLimit.limit', 100),
        },
      ],
    }),
    TypeOrmModule.forRootAsync(typeOrmAsyncConfig),

    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),

    // Preflight foundations (00.5) — must load before feature modules.
    UserContextModule,
    StorageModule,
    CacheModule,
    JobsModule,

    AuthModule,
    UsersModule,
    CustomersModule,
    VendorsModule,
    WarehousesModule,
    ItemsModule,
    VouchersModule,
    ReportsModule,
    YearConfigModule,
    RepsModule,
    SettingsModule,
    RegionsModule,
    ProductsModule,
    RoutesModule,
    InvoicesModule,
    CollectionsModule,
    SystemModule,
    RealtimeModule,
    TaxModule,
    MobileModule,
    UnitsModule,
    NotificationsModule,
    ApprovalsModule,
    AgentModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
