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

  // Google Places key for the lead finder (server-side only). Optional: when
  // absent the prospecting search endpoint reports 503 and the rest still runs.
  GOOGLE_PLACES_API_KEY: Joi.string().allow('').default(''),
  // ISO-3166 country used to bias free-text place lookup.
  GOOGLE_PLACES_REGION: Joi.string().length(2).uppercase().default('JO'),

  // ERP sync timings (ms). The two interval values are read from process.env
  // directly at class-definition time, because @Interval() is evaluated before
  // DI exists — they are validated here so a bad value still fails at boot.
  // Raised from 20s: ERP posting on a loaded on-prem box regularly runs past
  // 20s, and a cut-off there leaves a voucher exported-but-unconfirmed, which
  // costs more to reconcile than simply waiting does.
  ERP_HTTP_TIMEOUT_MS: Joi.number().min(1000).default(60000),
  ERP_OUTBOX_DRAIN_MS: Joi.number().min(5000).default(30000),
  ERP_PULL_INTERVAL_MS: Joi.number().min(30000).default(300000),

  // Dashboard origin used to build public quote links inside outgoing messages.
  PUBLIC_DASHBOARD_URL: Joi.string().uri().allow('').default(''),

  // Self-hosted OpenWA gateway for WhatsApp outreach. All optional: with no
  // URL the dashboard falls back to click-to-chat links.
  WHATSAPP_GATEWAY_URL: Joi.string().uri().allow('').default(''),
  WHATSAPP_API_KEY: Joi.string().allow('').default(''),
  WHATSAPP_SESSION_ID: Joi.string().allow('').default(''),
  WHATSAPP_COUNTRY_CODE: Joi.string()
    .pattern(/^\d{1,4}$/)
    .default('962'),
  // Floors chosen to stay well inside what an unofficial session tolerates.
  WHATSAPP_MIN_INTERVAL_MS: Joi.number().min(5000).default(20000),
  WHATSAPP_DAILY_CAP: Joi.number().min(1).max(1000).default(150),

  // Secret behind per-salesman activation keys. Optional: with no secret the
  // activation endpoint refuses every key rather than accepting any, so an
  // unconfigured server cannot silently hand out free seats.
  SALESMAN_ACTIVATION_SECRET: Joi.string().allow('').default(''),

  // Rep-offline watchdog threshold (minutes of silence before alerting).
  REP_OFFLINE_THRESHOLD_MINUTES: Joi.number().min(2).default(10),

  // Location-lock geofence radius in metres (restricted reps must be within
  // this distance of the customer's saved location to sell / act).
  CUSTOMER_PROXIMITY_RADIUS_M: Joi.number().min(5).default(100),

  // 32-byte hex (64 chars) when provided. Required only for REAL JoFotara
  // e-invoicing (production with JOFOTARA_MOCK=false). In mock mode it's optional
  // — secret.util derives a stable AES key from JWT_SECRET so the app still boots
  // and can encrypt stored secrets without a dedicated KMS key.
  JOFOTARA_KMS_KEY: Joi.string()
    .pattern(/^[0-9a-fA-F]{64}$/)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string()
        .pattern(/^[0-9a-fA-F]{64}$/)
        .when('JOFOTARA_MOCK', {
          is: false,
          then: Joi.required(),
          otherwise: Joi.optional(),
        }),
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
  // 'openai' was missing here while configuration.ts and AiProviderResolver both
  // supported it, so LLM_PROVIDER=openai failed Joi and the app refused to boot.
  LLM_PROVIDER: Joi.string()
    .valid('anthropic', 'gemini', 'openai')
    .default('anthropic'),
  ANTHROPIC_API_KEY: Joi.string().allow('').optional(),
  AGENT_MODEL: Joi.string().default('claude-sonnet-4-6'),
  GEMINI_API_KEY: Joi.string().allow('').optional(),
  GEMINI_MODEL: Joi.string().default('gemini-2.5-flash'),
  OPENAI_API_KEY: Joi.string().allow('').optional(),
  OPENAI_MODEL: Joi.string().default('gpt-4o'),
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
