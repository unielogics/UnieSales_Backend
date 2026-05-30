-- Tracks when a Gmail account's daily_sent_count was last rolled over, so the
-- followup worker can reset it once per day. Null → reset on next tick.
ALTER TABLE gmail_accounts ADD COLUMN IF NOT EXISTS daily_count_reset_at timestamp;
