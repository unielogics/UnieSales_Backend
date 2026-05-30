-- Sales Training: per-profile disable flag.
--
-- A disabled profile means: AI does not draft / auto-respond for inbound
-- leads matching this (site, tag). The post-intake runner creates a
-- human_handoff task instead of the usual review_ai_draft task, and
-- getForRuntime() returns null so the AI runtime never loads the training.
--
-- Additive only. Default false keeps every existing profile active.

ALTER TABLE sales_training_profiles
  ADD COLUMN IF NOT EXISTS disabled boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS sales_training_profiles_disabled_idx
  ON sales_training_profiles (workspace_id, disabled)
  WHERE disabled = true;
