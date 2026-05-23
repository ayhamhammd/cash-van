export default () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  database: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'cashvan',
    password: process.env.DB_PASSWORD ?? 'cashvan',
    database: process.env.DB_NAME ?? 'cashvan',
    ssl: process.env.DB_SSL === 'true',
    logging: process.env.DB_LOGGING === 'true',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? 'change-me',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  },
  rateLimit: {
    ttl: parseInt(process.env.RATE_LIMIT_TTL ?? '60', 10),
    limit: parseInt(process.env.RATE_LIMIT_LIMIT ?? '100', 10),
  },
  cors: {
    origins: process.env.CORS_ORIGINS ?? '*',
  },
  storage: {
    localRoot: process.env.STORAGE_LOCAL_ROOT ?? './storage',
    publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL ?? '/storage',
  },
  cache: {
    maxEntries: parseInt(process.env.CACHE_MAX_ENTRIES ?? '5000', 10),
    defaultTtlSec: parseInt(process.env.CACHE_DEFAULT_TTL_SEC ?? '300', 10),
  },
  jobs: {
    enabled: process.env.JOBS_ENABLED !== 'false',
  },
  jofotara: {
    // Mock the ISTD HTTP call until real sandbox credentials + contract exist.
    mock: process.env.JOFOTARA_MOCK !== 'false',
  },
});
