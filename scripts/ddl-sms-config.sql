-- Per-campaign SMS configuration: channel mode + quiet hours. Null = defaults
-- ('auto' mode, 20:00–09:00 quiet) applied at runtime.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sms_config jsonb;
