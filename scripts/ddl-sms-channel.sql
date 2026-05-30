-- Phase 2: SMS channel. Reuses the email_threads/email_messages tables with a
-- `channel` column so the existing reply pipeline (classify_reply →
-- auto-reply / book / hand off / queue) handles both email and SMS uniformly.

-- Per-lead channel (set at import time: email if has email, sms if phone-only).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';

-- Threads: channel + relax gmail_thread_id (SMS conversations have none).
ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';
ALTER TABLE email_threads ALTER COLUMN gmail_thread_id DROP NOT NULL;

-- Messages: channel + Twilio MessageSid for SMS rows.
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS twilio_message_sid text;

-- Lookup index for matching inbound SMS to a lead by phone digits.
CREATE INDEX IF NOT EXISTS leads_phone_digits_idx
  ON leads (workspace_id, (regexp_replace(coalesce(phone,''), '\D', '', 'g')));
