-- Notification scan dedup columns (deal-risk + task-due alerts). Additive, idempotent.
-- Run: psql "$DATABASE_URL" -f scripts/ddl-notifications-scan.sql

BEGIN;

-- Stamp set by the notifications worker after pushing a "task due" alert, so the
-- same task isn't re-notified on every scan tick.
ALTER TABLE sales_tasks ADD COLUMN IF NOT EXISTS due_notified_at timestamp;

-- Stamp set after pushing a "deal at risk" alert. Re-armed (re-notified) only
-- after a further week of continued staleness.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS risk_notified_at timestamp;

-- "Open tasks that just came due" — the worker's task-due scan predicate.
CREATE INDEX IF NOT EXISTS sales_tasks_due_scan_idx
  ON sales_tasks (due_at)
  WHERE status = 'open' AND due_notified_at IS NULL;

COMMIT;
