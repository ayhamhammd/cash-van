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

  // Rep-offline watchdog threshold (minutes of silence before alerting).
  REP_OFFLINE_THRESHOLD_MINUTES: Joi.number().min(2).default(10),

  // Location-lock geofence radius in metres (restricted reps must be within
  // this distance of the customer's saved location to sell / act).
  CUSTOMER_PROXIMITY_RADIUS_M: Joi.number().min(100).default(1000),

  // 32-byte hex (64 chars). Required in production; dev fallback in code.
  JOFOTARA_KMS_KEY: Joi.string()
    .pattern(/^[0-9a-fA-F]{64}$/)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),

  // Phone-hash salt. Required in production; dev fallback in code.
  PHONE_HASH_SECRET: Joi.string().min(16).when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),

  // Mock the ISTD JoFotara HTTP call (true until real creds + contract exist).
  JOFOTARA_MOCK: Joi.boolean().default(true),

  // --- AI report agent ---------------------------------------------------
  // Which LLM vendor drives the agent. The selected provider's API key is
  // required at runtime (a clean error is streamed if it's missing) — kept
  // optional in Joi so switching providers doesn't trip boot validation.
  LLM_PROVIDER: Joi.string().valid('anthropic', 'gemini').default('anthropic'),
  ANTHROPIC_API_KEY: Joi.string().allow('').optional(),
  AGENT_MODEL: Joi.string().default('claude-sonnet-4-6'),
  GEMINI_API_KEY: Joi.string().allow('').optional(),
  GEMINI_MODEL: Joi.string().default('gemini-2.5-flash'),
  AGENT_MAX_TOKENS: Joi.number().default(4096),
  AGENT_MAX_ITERATIONS: Joi.number().default(8),
  AGENT_SQL_PREVIEW_ROWS: Joi.number().default(50),
  AGENT_SQL_ROW_LIMIT: Joi.number().default(5000),
  AGENT_SQL_TIMEOUT_MS: Joi.number().default(15000),

  // Read-only Postgres role for the agent's generated SQL. Optional at boot —
  // ReadonlyDbService falls back to the main DB creds (read-only transaction
  // still enforced) and logs a warning when it's unset, so a missing dedicated
  // role degrades the agent gracefully instead of crashing the whole API on
  // start. Provision `report_agent` + set REPORT_DB_PASSWORD for stricter prod
  // isolation.
  REPORT_DB_USER: Joi.string().default('report_agent'),
  REPORT_DB_PASSWORD: Joi.string().allow('').optional(),
});
