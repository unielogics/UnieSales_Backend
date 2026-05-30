-- Sales Training surface — per-product AI training profiles.
-- Idempotent (IF NOT EXISTS everywhere). Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS sales_training_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  slug            text NOT NULL,
  name            text NOT NULL,
  description     text,

  -- Source binding — links a profile to an intake (site, tag). Null on custom.
  source_site     text,
  source_tag      text,

  -- Structured editors (operator-curated, AI-read)
  faqs            jsonb NOT NULL DEFAULT '[]'::jsonb,
  behavior        jsonb NOT NULL DEFAULT '{}'::jsonb,
  cross_sell      jsonb NOT NULL DEFAULT '[]'::jsonb,

  status          text NOT NULL DEFAULT 'needs_setup',
  trained_summary text,
  trained_at      timestamptz,

  seed_protected  boolean NOT NULL DEFAULT false,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sales_training_profiles_workspace_slug_unique
    UNIQUE (workspace_id, slug),
  CONSTRAINT sales_training_profiles_workspace_source_unique
    UNIQUE (workspace_id, source_site, source_tag)
);

CREATE INDEX IF NOT EXISTS sales_training_profiles_workspace_idx
  ON sales_training_profiles (workspace_id);
CREATE INDEX IF NOT EXISTS sales_training_profiles_source_idx
  ON sales_training_profiles (workspace_id, source_site, source_tag)
  WHERE source_site IS NOT NULL;

CREATE TABLE IF NOT EXISTS sales_training_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid NOT NULL REFERENCES sales_training_profiles(id) ON DELETE CASCADE,
  role            text NOT NULL,
  content         text NOT NULL,
  input_tokens    integer,
  output_tokens   integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_training_messages_profile_idx
  ON sales_training_messages (profile_id, created_at);

CREATE TABLE IF NOT EXISTS sales_training_knowledge (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid NOT NULL REFERENCES sales_training_profiles(id) ON DELETE CASCADE,
  title           text NOT NULL,
  content         text NOT NULL,
  source_type     text NOT NULL DEFAULT 'typed',
  ordinal         integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_training_knowledge_content_len
    CHECK (char_length(content) <= 20000),
  CONSTRAINT sales_training_knowledge_title_len
    CHECK (char_length(title) BETWEEN 1 AND 120)
);
CREATE INDEX IF NOT EXISTS sales_training_knowledge_profile_idx
  ON sales_training_knowledge (profile_id, ordinal, created_at);

COMMIT;
