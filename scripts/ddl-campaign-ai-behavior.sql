-- Layer 2 — Per-campaign AI behavior cards.
-- Stores the structured rule set the runtime reads when deciding what to do
-- with a lead (post-intake runner, reply triage, follow-up scheduler).
-- One row per campaign. Cards JSONB has 10 fixed keys (lead_intelligence,
-- first_response, email_followup, booking_behavior, form_behavior,
-- task_creation, note_creation, handoff, exit_logic, ai_safety).

BEGIN;

CREATE TABLE IF NOT EXISTS campaign_ai_behavior (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  cards jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_ai_behavior_unique_campaign
  ON campaign_ai_behavior(campaign_id);

COMMIT;
