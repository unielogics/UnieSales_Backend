-- Campaigns can be configured in advance with a scheduled start time. The
-- followup worker auto-activates them when the time arrives (running the
-- normal activation gate). Cleared once activation fires.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_start_at timestamp;
