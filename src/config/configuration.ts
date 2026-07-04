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
  // Rep-offline watchdog: minutes of silence (no heartbeat/ping) before an
  // active rep is alerted as offline.
  heartbeat: {
    offlineThresholdMin: parseInt(
      process.env.REP_OFFLINE_THRESHOLD_MINUTES ?? '10',
      10,
    ),
  },
  // Location-lock geofence: how close (metres) a restricted rep must be to a
  // customer's saved location to sell / act on that customer. An area, not an
  // exact point — default ~1 km.
  geofence: {
    radiusM: parseInt(process.env.CUSTOMER_PROXIMITY_RADIUS_M ?? '1000', 10),
  },
  jofotara: {
    // Mock the ISTD HTTP call until real sandbox credentials + contract exist.
    mock: process.env.JOFOTARA_MOCK !== 'false',
  },
  // AI report agent (NL prompt -> SELECT -> rendered report).
  // Which LLM vendor drives the agent: 'anthropic' (default) or 'gemini'.
  llm: {
    provider: process.env.LLM_PROVIDER ?? 'anthropic',
  },
  // Google Gemini settings (used when LLM_PROVIDER=gemini).
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  },
  // OpenAI (ChatGPT) settings (used when LLM_PROVIDER=openai). Preferred config
  // is the Settings → AI panel; these are the env fallback.
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o',
  },
  agent: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.AGENT_MODEL ?? 'claude-sonnet-4-6',
    maxTokens: parseInt(process.env.AGENT_MAX_TOKENS ?? '4096', 10),
    maxIterations: parseInt(process.env.AGENT_MAX_ITERATIONS ?? '8', 10),
    // Rows embedded in run_sql tool results (model context) — kept small.
    sqlPreviewRows: parseInt(process.env.AGENT_SQL_PREVIEW_ROWS ?? '50', 10),
    // Hard ceiling on rows pulled into a generated report file.
    sqlRowLimit: parseInt(process.env.AGENT_SQL_ROW_LIMIT ?? '5000', 10),
    sqlTimeoutMs: parseInt(process.env.AGENT_SQL_TIMEOUT_MS ?? '15000', 10),
  },
  // Dedicated read-only Postgres role the agent uses for model-generated SQL.
  // Host/port/database are inherited from `database.*`; only the login differs.
  reportDb: {
    user: process.env.REPORT_DB_USER ?? 'report_agent',
    password: process.env.REPORT_DB_PASSWORD ?? '',
  },
});
