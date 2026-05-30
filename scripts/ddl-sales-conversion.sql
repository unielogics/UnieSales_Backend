-- Layer 2 sales-conversion backbone tables.
-- Schema-only change: services exist as helpers but no UI/runtime yet writes
-- here. The next phase (Inbound Leads view + post-intake runner) will start
-- producing rows. All ALTERs/CREATEs are guarded so reruns are safe.

BEGIN;

-- 1) sales_activities — append-only audit trail of everything a lead is touched by.
CREATE TABLE IF NOT EXISTS sales_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  lead_id uuid REFERENCES leads(id),
  campaign_id uuid REFERENCES campaigns(id),
  activity_type text NOT NULL,
  title text,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_activities_workspace_lead_created_idx
  ON sales_activities(workspace_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sales_activities_workspace_created_idx
  ON sales_activities(workspace_id, created_at DESC);

-- 2) sales_notes — manual + AI-generated notes attached to a lead.
CREATE TABLE IF NOT EXISTS sales_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  lead_id uuid NOT NULL REFERENCES leads(id),
  kind text NOT NULL,
  title text,
  body text NOT NULL,
  author_user_id uuid REFERENCES users(id),
  ai_action_id uuid REFERENCES ai_actions(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_notes_workspace_lead_created_idx
  ON sales_notes(workspace_id, lead_id, created_at DESC);

-- 3) sales_tasks — queued AI + manual tasks for the operator.
CREATE TABLE IF NOT EXISTS sales_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  lead_id uuid REFERENCES leads(id),
  title text NOT NULL,
  type text NOT NULL,
  priority text NOT NULL DEFAULT 'med',
  status text NOT NULL DEFAULT 'open',
  due_at timestamp,
  source text NOT NULL DEFAULT 'manual',
  owner_user_id uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  completed_at timestamp
);
CREATE INDEX IF NOT EXISTS sales_tasks_workspace_status_idx
  ON sales_tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS sales_tasks_lead_status_idx
  ON sales_tasks(lead_id, status);
CREATE INDEX IF NOT EXISTS sales_tasks_owner_due_idx
  ON sales_tasks(owner_user_id, due_at);

-- 4) lead_processing_locks — idempotency fence for background runners.
CREATE TABLE IF NOT EXISTS lead_processing_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  lead_id uuid NOT NULL REFERENCES leads(id),
  process_name text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  created_at timestamp NOT NULL DEFAULT now(),
  completed_at timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS lead_processing_locks_unique
  ON lead_processing_locks(lead_id, process_name);

-- 5) leads — pipeline stage + post-intake processed timestamp.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS pipeline_stage text,
  ADD COLUMN IF NOT EXISTS post_intake_processed_at timestamp;
CREATE INDEX IF NOT EXISTS leads_workspace_pipeline_idx
  ON leads(workspace_id, pipeline_stage);

COMMIT;
