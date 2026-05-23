-- Runs once on first container start (when volume is empty).
-- TypeORM migrations create application tables; this only enables extensions.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive text (emails, codes)
CREATE EXTENSION IF NOT EXISTS "btree_gin";  -- composite indexing helpers
