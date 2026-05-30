-- Place a `dismissed_at` marker on email_threads so the operator can drop
-- a thread from their Inbox view without affecting the underlying Gmail
-- message or the lead it's attached to.
--
-- Filter pattern: every Inbox list query adds `dismissed_at IS NULL`.
-- Dismissed threads still exist in the DB and Gmail; they just don't
-- crowd the operator's working surface.
--
-- Additive; safe to re-run.

ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
CREATE INDEX IF NOT EXISTS email_threads_dismissed_at_idx
  ON email_threads (workspace_id, dismissed_at)
  WHERE dismissed_at IS NOT NULL;
