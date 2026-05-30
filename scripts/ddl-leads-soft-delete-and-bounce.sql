-- Lead lifecycle: soft-delete + email-send-failure suppression.
--
-- 1. `deleted_at` — when set, the lead is hidden from every UI list and
--    every AI worker. The row stays in the DB (audit trail, restore
--    possible). The operator deletes leads from Inbound Leads view via
--    right-click or Ctrl+multi-select.
--
-- 2. `email_send_failed_at` + `email_send_fail_reason` — set when a
--    Gmail send to lead.email fails (bounce, invalid address, permanent
--    rejection). The followup worker filters these out so the AI never
--    retries to a known-broken address. Reset when lead.email is updated
--    (operator fixed the address).
--
-- Both additive; safe to re-run.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS leads_deleted_at_idx
  ON leads (workspace_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_send_failed_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_send_fail_reason text;
CREATE INDEX IF NOT EXISTS leads_email_send_failed_idx
  ON leads (workspace_id, email_send_failed_at)
  WHERE email_send_failed_at IS NOT NULL;
