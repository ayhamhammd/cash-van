import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),

  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  DB_SSL: Joi.boolean().default(false),
  DB_LOGGING: Joi.boolean().default(false),

  JWT_SECRET: Joi.string().min(16).required(),
  JWT_EXPIRES_IN: Joi.string().default('12h'),

  RATE_LIMIT_TTL: Joi.number().default(60),
  RATE_LIMIT_LIMIT: Joi.number().default(100),

  CORS_ORIGINS: Joi.string().default('*'),

  STORAGE_LOCAL_ROOT: Joi.string().default('./storage'),
  STORAGE_PUBLIC_BASE_URL: Joi.string().default('/storage'),

  CACHE_MAX_ENTRIES: Joi.number().default(5000),
  CACHE_DEFAULT_TTL_SEC: Joi.number().default(300),

  JOBS_ENABLED: Joi.boolean().default(true),

  // 32-byte hex (64 chars). Required in production; dev fallback in code.
  JOFOTARA_KMS_KEY: Joi.string()
    .pattern(/^[0-9a-fA-F]{64}$/)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),

  // Phone-hash salt. Required in production; dev fallback in code.
  PHONE_HASH_SECRET: Joi.string()
    .min(16)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),

  // Mock the ISTD JoFotara HTTP call (true until real creds + contract exist).
  JOFOTARA_MOCK: Joi.boolean().default(true),
});
