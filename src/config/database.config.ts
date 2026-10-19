import { TypeOrmModuleAsyncOptions, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';

export const typeOrmAsyncConfig: TypeOrmModuleAsyncOptions = {
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService): TypeOrmModuleOptions => ({
    type: 'postgres',
    host: config.get<string>('database.host'),
    port: config.get<number>('database.port'),
    // The RUNNING APP prefers the unprivileged role, so row-level security
    // applies to it — a superuser silently ignores every policy. Migrations run
    // through data-source.ts, which always uses the owning DB_USERNAME.
    username:
      config.get<string>('database.appUsername') ||
      config.get<string>('database.username'),
    password:
      config.get<string>('database.appUsername')
        ? config.get<string>('database.appPassword')
        : config.get<string>('database.password'),
    database: config.get<string>('database.database'),
    ssl: config.get<boolean>('database.ssl')
      ? { rejectUnauthorized: false }
      : false,
    logging: config.get<boolean>('database.logging'),
    // *.view.ts is listed explicitly because @ViewEntity files do not match the
    // *.entity.ts glob. They used to arrive via TypeOrmModule.forFeature, but
    // feature modules now use TenantOrmModule.forFeature (which hands out
    // tenant-scoped repositories) and no longer feed autoLoadEntities.
    entities: [
      __dirname + '/../**/*.entity.{ts,js}',
      __dirname + '/../**/*.view.{ts,js}',
    ],
    autoLoadEntities: true,
    migrations: [__dirname + '/../database/migrations/*.{ts,js}'],
    migrationsRun: false,
    synchronize: false,
    poolSize: 10,
    extra: {
      max: 10,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
      query_timeout: 30_000,
    },
  }),
};
