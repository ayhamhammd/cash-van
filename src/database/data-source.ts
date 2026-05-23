import { DataSource, DataSourceOptions } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv();

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME ?? 'cashvan',
  password: process.env.DB_PASSWORD ?? 'cashvan',
  database: process.env.DB_NAME ?? 'cashvan',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  entities: [__dirname + '/../**/*.entity.{ts,js}'],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  logging: process.env.DB_LOGGING === 'true',
  synchronize: false,
};

export default new DataSource(dataSourceOptions);
