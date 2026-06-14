CREATE TABLE IF NOT EXISTS "cost_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "campaign_id" uuid REFERENCES "campaigns"("id"),
  "lead_id" uuid REFERENCES "leads"("id"),
  "email_thread_id" uuid REFERENCES "email_threads"("id"),
  "email_message_id" uuid REFERENCES "email_messages"("id"),
  "ai_action_id" uuid REFERENCES "ai_actions"("id"),
  "source_object_type" text,
  "source_object_id" text,
  "dedupe_key" text NOT NULL,
  "provider" text NOT NULL,
  "service" text NOT NULL,
  "category" text NOT NULL,
  "action_type" text,
  "channel" text,
  "quantity" numeric(18, 6) DEFAULT '1' NOT NULL,
  "unit" text NOT NULL,
  "unit_cost_usd" numeric(18, 9) DEFAULT '0' NOT NULL,
  "amount_usd" numeric(18, 9) DEFAULT '0' NOT NULL,
  "currency" text DEFAULT 'USD' NOT NULL,
  "pricing_version" text DEFAULT 'default' NOT NULL,
  "cost_source" text DEFAULT 'estimated' NOT NULL,
  "occurred_at" timestamp DEFAULT now() NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_events_dedupe_unique" ON "cost_events" ("dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_workspace_time_idx" ON "cost_events" ("workspace_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_campaign_idx" ON "cost_events" ("campaign_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_lead_idx" ON "cost_events" ("lead_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_provider_idx" ON "cost_events" ("provider", "service");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_rate_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid REFERENCES "workspaces"("id"),
  "provider" text NOT NULL,
  "service" text NOT NULL,
  "category" text NOT NULL,
  "action_type" text,
  "unit" text NOT NULL,
  "unit_cost_usd" numeric(18, 9) DEFAULT '0' NOT NULL,
  "currency" text DEFAULT 'USD' NOT NULL,
  "pricing_version" text DEFAULT 'default' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_rate_cards_lookup_idx" ON "cost_rate_cards" (
  "workspace_id",
  "provider",
  "service",
  "category",
  "action_type",
  "unit"
);
