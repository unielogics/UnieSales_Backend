CREATE TABLE IF NOT EXISTS "lead_ai_briefs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "lead_id" uuid NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "primary_product_profile_id" uuid REFERENCES "sales_training_profiles"("id"),
  "related_product_profile_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "objective" text,
  "operator_context" text,
  "constraints" text,
  "next_step" text,
  "clarifying_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "product_suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "sequence_state" text DEFAULT 'draft' NOT NULL,
  "first_draft_action_id" uuid REFERENCES "ai_actions"("id"),
  "approved_at" timestamp,
  "last_generated_at" timestamp,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "lead_ai_briefs_workspace_lead_unique"
  ON "lead_ai_briefs" ("workspace_id", "lead_id");

CREATE INDEX IF NOT EXISTS "lead_ai_briefs_workspace_idx"
  ON "lead_ai_briefs" ("workspace_id");

CREATE INDEX IF NOT EXISTS "lead_ai_briefs_lead_idx"
  ON "lead_ai_briefs" ("lead_id");

CREATE INDEX IF NOT EXISTS "lead_ai_briefs_sequence_idx"
  ON "lead_ai_briefs" ("sequence_state", "approved_at");
