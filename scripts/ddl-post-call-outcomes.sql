ALTER TABLE gmail_accounts
  ADD COLUMN IF NOT EXISTS connected_by_user_id uuid REFERENCES users(id);

CREATE INDEX IF NOT EXISTS gmail_accounts_connected_by_idx
  ON gmail_accounts (connected_by_user_id);

ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS outcome_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS meeting_outcome text,
  ADD COLUMN IF NOT EXISTS outcome_reason text,
  ADD COLUMN IF NOT EXISTS outcome_notes text,
  ADD COLUMN IF NOT EXISTS outcome_next_action text,
  ADD COLUMN IF NOT EXISTS outcome_logged_at timestamp,
  ADD COLUMN IF NOT EXISTS outcome_logged_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS outcome_snoozed_until timestamp,
  ADD COLUMN IF NOT EXISTS outcome_task_id uuid,
  ADD COLUMN IF NOT EXISTS next_step_task_id uuid,
  ADD COLUMN IF NOT EXISTS next_step_calendar_event_id uuid,
  ADD COLUMN IF NOT EXISTS meet_conference_record text,
  ADD COLUMN IF NOT EXISTS meet_artifact_status text,
  ADD COLUMN IF NOT EXISTS meet_transcript_text text,
  ADD COLUMN IF NOT EXISTS meet_notes_text text,
  ADD COLUMN IF NOT EXISTS meet_artifact_synced_at timestamp,
  ADD COLUMN IF NOT EXISTS meet_artifact_error text;

CREATE INDEX IF NOT EXISTS calendar_events_workspace_outcome_idx
  ON calendar_events (workspace_id, end_at, outcome_logged_at);
