-- Token accounting on ai_actions (AI cost optimization). Additive, idempotent.
-- Run: psql "$DATABASE_URL" -f scripts/ddl-ai-action-tokens.sql

ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS input_tokens          integer;
ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS output_tokens         integer;
ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS cache_read_tokens     integer;
ALTER TABLE ai_actions ADD COLUMN IF NOT EXISTS cache_creation_tokens integer;
