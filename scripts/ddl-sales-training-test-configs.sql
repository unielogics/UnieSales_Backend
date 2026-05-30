-- Sales Training: per-tag test-inbound configuration.
--
-- A jsonb map keyed by intake tag (e.g. 'talk_to_sales') → { email,
-- contactName, lastSentAt }. The operator configures a test recipient per
-- form so the "Run test" button in the training workbench can simulate a
-- real inbound submission and have the AI actually send a draft email to
-- that address. Pre-launch verification.
--
-- Tag is the bare tag (no site prefix) — the site is implied by the parent
-- profile's source_site column.
--
-- Additive only. Default '{}' keeps every existing profile valid.

ALTER TABLE sales_training_profiles
  ADD COLUMN IF NOT EXISTS test_configs jsonb NOT NULL DEFAULT '{}'::jsonb;
