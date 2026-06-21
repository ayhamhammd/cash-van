-- Provision the read-only Postgres role used by the AI report agent.
--
-- Run ONCE per deployment, as a superuser / the database owner, AFTER the app
-- has run its migrations (so all tables exist):
--
--   psql "$DATABASE_URL" -v role_pw="'a-strong-password'" -f scripts/sql/report-agent-role.sql
--
-- Then set REPORT_DB_USER=report_agent and REPORT_DB_PASSWORD=a-strong-password
-- in the app environment.
--
-- The role can only SELECT. The app additionally wraps every agent query in a
-- READ ONLY, always-rolled-back transaction with a statement_timeout, and
-- validates that the SQL is a single SELECT before it runs — defence in depth.

\set ON_ERROR_STOP on

-- 1. The login role (no inherited write privileges).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'report_agent') THEN
    EXECUTE format('CREATE ROLE report_agent LOGIN PASSWORD %L', :'role_pw');
  ELSE
    EXECUTE format('ALTER ROLE report_agent WITH LOGIN PASSWORD %L', :'role_pw');
  END IF;
END
$$;

-- 2. Connect + read the public schema, nothing else.
GRANT CONNECT ON DATABASE current_database() TO report_agent;
-- (If the above errors on your PG version, replace current_database() with the
--  literal database name, e.g. GRANT CONNECT ON DATABASE cashvan TO report_agent;)
GRANT USAGE ON SCHEMA public TO report_agent;

-- 3. SELECT on every existing table + every table created later.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO report_agent;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO report_agent;

-- 4. Make sure no write paths leak in (revoke the broad default if present).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM report_agent;

-- Optional hardening: keep the agent away from sensitive tables entirely.
-- REVOKE SELECT ON users, app_settings FROM report_agent;
