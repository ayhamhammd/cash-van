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
    // The unprivileged role the RUNNING APP connects as, so row-level security
    // actually applies to it. Migrations keep using DB_USERNAME, which owns the
    // tables. Leave unset to run without tenant enforcement (single-tenant
    // installs) — the app warns loudly on boot when that is the case.
    appUsername: process.env.DB_APP_USERNAME ?? '',
    appPassword: process.env.DB_APP_PASSWORD ?? '',
  },
  // Shared secret the CRM control plane presents when creating a company here.
  // Unset = provisioning is switched off, not merely unguarded.
  internalProvisionSecret: process.env.INTERNAL_PROVISION_SECRET ?? '',
  // Bind untenanted requests (login, webhooks) to the default tenant. Correct
  // for a SINGLE-COMPANY install, where every row belongs to it anyway, and
  // what keeps on-premise deployments logging in exactly as before. Turn OFF
  // on a shared deployment: there the company cannot be guessed, and dashboard
  // users authenticate through the CRM instead.
  tenantFallbackEnabled: process.env.TENANT_FALLBACK_ENABLED !== 'false',
  // Licensing. Unset CRM url = licensing OFF entirely, which is what a
  // single-company or on-premise install runs — every route passes and nothing
  // phones home.
  licensing: {
    crmBaseUrl: (process.env.CRM_BASE_URL ?? '').replace(/\/+$/, ''),
    // How stale a cached entitlement may be before re-checking. The lever on
    // how quickly a suspension bites.
    cacheTtlMs: parseInt(process.env.LICENSE_CACHE_TTL_MS ?? '60000', 10),
    // How long a cached entitlement keeps being served when the CRM is DOWN.
    // Generous on purpose: a control-plane outage must not stop vans selling.
    staleGraceMs: parseInt(process.env.LICENSE_STALE_GRACE_MS ?? '86400000', 10),
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
  // Origin of the office dashboard, used to build the public /q/<token> quote
  // links that go out in WhatsApp messages. Deliberately NOT taken from the
  // request: a client-supplied origin would let a caller mint links pointing
  // anywhere while looking like they came from us.
  publicDashboardUrl: (process.env.PUBLIC_DASHBOARD_URL ?? '').replace(/\/+$/, ''),
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
  // Google Places (lead finder). SERVER-SIDE ONLY — never expose this key to
  // the browser. Unset = the prospecting search endpoint returns 503.
  places: {
    apiKey: process.env.GOOGLE_PLACES_API_KEY ?? '',
    // Biases free-text place lookup to the country of operation, so "Sweifieh"
    // resolves to the Amman district and not a namesake elsewhere.
    regionCode: process.env.GOOGLE_PLACES_REGION ?? 'JO',
  },
  // ERP sync timings. All millisecond values, all overridable from .env so a
  // slow or distant ERP can be accommodated without a rebuild.
  erp: {
    /** Per-request timeout for every ERP HTTP call. */
    httpTimeoutMs: parseInt(process.env.ERP_HTTP_TIMEOUT_MS ?? '60000', 10),
  },
  // Self-hosted OpenWA gateway (github.com/rmyndharis/OpenWA) used to send
  // quote links on WhatsApp. Unset baseUrl = outreach falls back to
  // click-to-chat links in the dashboard, and the send endpoint returns 503.
  //
  // The pacing defaults are deliberately slow. OpenWA drives an UNOFFICIAL
  // WhatsApp session, and its own docs are blunt about it: blasting first-ever
  // messages at numbers that never messaged you is the fastest way to get the
  // number restricted, with no route to appeal. A few per minute is safe.
  whatsapp: {
    baseUrl: (process.env.WHATSAPP_GATEWAY_URL ?? '').replace(/\/+$/, ''),
    apiKey: process.env.WHATSAPP_API_KEY ?? '',
    sessionId: process.env.WHATSAPP_SESSION_ID ?? '',
    /** Country code prefixed to local numbers when building a chatId. */
    countryCode: process.env.WHATSAPP_COUNTRY_CODE ?? '962',
    /** Floor on the gap between two sends, before jitter. */
    minIntervalMs: parseInt(process.env.WHATSAPP_MIN_INTERVAL_MS ?? '20000', 10),
    /** Hard stop per calendar day, counted per process. */
    dailyCap: parseInt(process.env.WHATSAPP_DAILY_CAP ?? '150', 10),
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
    // ── Python sandbox (SPEC-ai-analyst Phase 4) ─────────────────────────────
    // OFF by default, and it must stay that way unless a site has both the
    // memory headroom and an informed view of the docker-socket trade-off
    // documented in docs/SPEC-ai-python-sandbox.md.
    python: {
      enabled: process.env.AI_PYTHON_ENABLED === 'true',
      image: process.env.AI_PYTHON_IMAGE ?? 'vanflow-pysandbox:latest',
      timeoutMs: parseInt(process.env.AI_PYTHON_TIMEOUT_MS ?? '30000', 10),
      memory: process.env.AI_PYTHON_MEMORY ?? '512m',
      cpus: process.env.AI_PYTHON_CPUS ?? '1',
      // Rows handed to the script. Large enough for real analysis, small enough
      // that a runaway query cannot fill the job directory.
      maxRows: parseInt(process.env.AI_PYTHON_MAX_ROWS ?? '50000', 10),
      workDir: process.env.AI_PYTHON_WORKDIR ?? '/tmp/vanflow-py',
    },
  },
  // Dedicated read-only Postgres role the agent uses for model-generated SQL.
  // Host/port/database are inherited from `database.*`; only the login differs.
  reportDb: {
    user: process.env.REPORT_DB_USER ?? 'report_agent',
    password: process.env.REPORT_DB_PASSWORD ?? '',
  },
});
