import { TypeOrmModuleAsyncOptions, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';

export const typeOrmAsyncConfig: TypeOrmModuleAsyncOptions = {
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService): TypeOrmModuleOptions => ({
    type: 'postgres',
    host: config.get<string>('database.host'),
    port: config.get<number>('database.port'),
    username: config.get<string>('database.username'),
    password: config.get<string>('database.password'),
    database: config.get<string>('database.database'),
    ssl: config.get<boolean>('database.ssl')
      ? { rejectUnauthorized: false }
      : false,
    logging: config.get<boolean>('database.logging'),
    entities: [__dirname + '/../**/*.entity.{ts,js}'],
    // Also register entities provided via forFeature() that the glob misses —
    // notably @ViewEntity files (e.g. *.view.ts like ItemBalanceView).
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
