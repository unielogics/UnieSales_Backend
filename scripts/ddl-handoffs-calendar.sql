-- Additive DDL for the Handoffs + Calendar feature set.
-- Safe to run repeatedly: every statement is IF NOT EXISTS.
-- Apply on EC2:  psql "$DATABASE_URL" -f scripts/ddl-handoffs-calendar.sql

-- ── handoffs ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS handoffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id),
  lead_id         uuid NOT NULL REFERENCES leads(id),
  campaign_id     uuid REFERENCES campaigns(id),
  email_thread_id uuid REFERENCES email_threads(id),
  status          text NOT NULL DEFAULT 'open',
  reason          text,
  notes           text,
  due_date        timestamp,
  assignee        text,
  resolution      text,
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now(),
  resolved_at     timestamp
);
CREATE INDEX IF NOT EXISTS handoffs_workspace_idx        ON handoffs (workspace_id);
CREATE INDEX IF NOT EXISTS handoffs_lead_idx             ON handoffs (lead_id);
CREATE INDEX IF NOT EXISTS handoffs_workspace_status_idx ON handoffs (workspace_id, status);

-- ── calendar_events ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calendar_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id),
  gmail_account_id   uuid NOT NULL REFERENCES gmail_accounts(id),
  lead_id            uuid REFERENCES leads(id),
  campaign_id        uuid REFERENCES campaigns(id),
  email_thread_id    uuid REFERENCES email_threads(id),
  google_event_id    text,
  google_calendar_id text NOT NULL DEFAULT 'primary',
  title              text NOT NULL,
  description        text,
  start_at           timestamp NOT NULL,
  end_at             timestamp NOT NULL,
  attendees          jsonb,
  meet_link          text,
  location           text,
  status             text NOT NULL DEFAULT 'confirmed',
  source             text NOT NULL DEFAULT 'app',
  created_at         timestamp NOT NULL DEFAULT now(),
  updated_at         timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_events_workspace_idx       ON calendar_events (workspace_id);
CREATE INDEX IF NOT EXISTS calendar_events_workspace_start_idx ON calendar_events (workspace_id, start_at);
-- Non-partial: Postgres treats NULL google_event_id as distinct, so app-created
-- rows that haven't synced an id yet never collide. Matches the Drizzle schema
-- so ON CONFLICT (gmail_account_id, google_event_id) resolves to this index.
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_google_unique
  ON calendar_events (gmail_account_id, google_event_id);
