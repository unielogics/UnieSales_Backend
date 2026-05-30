-- Outcome of the most recent import for a lead source — created /
-- skipped_existing / skipped_invalid / total_rows. Lets the UI surface what
-- an auto-import did (e.g. "176 skipped — no email") without a manual run.
ALTER TABLE campaign_lead_sources ADD COLUMN IF NOT EXISTS last_import_result jsonb;
