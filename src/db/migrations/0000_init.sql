CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"company_name" text NOT NULL,
	"brand_name" text,
	"industry" text,
	"website" text,
	"default_from_email" text,
	"default_sender_name" text,
	"default_booking_link" text,
	"notification_email" text,
	"crm_type" text DEFAULT 'internal' NOT NULL,
	"auto_reply_enabled" boolean DEFAULT false NOT NULL,
	"auto_reply_confidence_threshold" numeric(4, 3) DEFAULT '0.850' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_role_check" CHECK ("workspace_members"."role" IN ('owner','admin','viewer'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_ai_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"profile_name" text NOT NULL,
	"system_prompt" text NOT NULL,
	"prohibited_claims" text,
	"required_disclaimers" text,
	"tone_rules" text,
	"handoff_rules" text,
	"auto_reply_rules" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gmail_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"sender_name" text,
	"google_user_id" text,
	"access_token_encrypted" text,
	"refresh_token_encrypted" text,
	"token_expiry" timestamp,
	"domain" text,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"daily_send_limit" integer DEFAULT 25 NOT NULL,
	"daily_sent_count" integer DEFAULT 0 NOT NULL,
	"max_new_threads_per_day" integer DEFAULT 25 NOT NULL,
	"warmup_mode" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"campaign_type" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"target_audience" text,
	"offer" text,
	"goal_summary" text,
	"primary_cta" text,
	"ai_positioning" text,
	"ai_rules" text,
	"safe_auto_reply_rules" jsonb,
	"handoff_rules" jsonb,
	"max_followups" integer DEFAULT 4 NOT NULL,
	"followup_schedule" jsonb,
	"daily_send_limit" integer DEFAULT 25 NOT NULL,
	"gmail_account_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"primary_goal" text NOT NULL,
	"secondary_goal" text,
	"primary_cta" text NOT NULL,
	"success_definition" text,
	"qualified_reply_definition" text,
	"target_audience" text,
	"offer_summary" text,
	"allowed_claims" text,
	"prohibited_claims" text,
	"handoff_triggers" text,
	"auto_reply_boundaries" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_knowledge_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_type" text,
	"s3_url" text,
	"extracted_text" text,
	"summary" text,
	"document_type" text,
	"extraction_status" text DEFAULT 'pending' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_lead_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_name" text,
	"google_sheet_id" text,
	"google_sheet_tab" text,
	"uploaded_file_url" text,
	"field_mapping" jsonb,
	"import_frequency" text DEFAULT 'manual' NOT NULL,
	"last_imported_at" timestamp,
	"import_status" text DEFAULT 'pending' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid,
	"gmail_account_id" uuid,
	"company_name" text,
	"website" text,
	"contact_name" text,
	"email" text NOT NULL,
	"phone" text,
	"title" text,
	"linkedin_url" text,
	"segment" text,
	"source" text,
	"source_url" text,
	"source_notes" text,
	"lead_score" integer DEFAULT 0 NOT NULL,
	"lead_score_reason" text,
	"pain_angle" text,
	"personalization" text,
	"status" text DEFAULT 'new' NOT NULL,
	"lifecycle_status" text DEFAULT 'active' NOT NULL,
	"close_reason" text,
	"closed_at" timestamp,
	"paused_until" timestamp,
	"first_contacted_at" timestamp,
	"last_contacted_at" timestamp,
	"last_engagement_at" timestamp,
	"next_action_at" timestamp,
	"email_attempt_count" integer DEFAULT 0 NOT NULL,
	"no_reply_count" integer DEFAULT 0 NOT NULL,
	"followup_count" integer DEFAULT 0 NOT NULL,
	"reactivation_eligible_at" timestamp,
	"gmail_thread_id" text,
	"hubspot_contact_id" text,
	"sheet_row_id" text,
	"ai_owner" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid,
	"lead_id" uuid,
	"gmail_account_id" uuid,
	"gmail_thread_id" text NOT NULL,
	"latest_gmail_message_id" text,
	"subject" text,
	"status" text DEFAULT 'active' NOT NULL,
	"ai_owner" boolean DEFAULT true NOT NULL,
	"last_inbound_at" timestamp,
	"last_outbound_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid,
	"lead_id" uuid,
	"email_thread_id" uuid,
	"gmail_message_id" text,
	"gmail_thread_id" text,
	"direction" text,
	"from_email" text,
	"to_email" text,
	"subject" text,
	"body" text,
	"ai_classification" text,
	"ai_summary" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid,
	"lead_id" uuid,
	"email_thread_id" uuid,
	"action_type" text,
	"status" text,
	"confidence" numeric(4, 3),
	"reason" text,
	"ai_output" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_training_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"started_by_user_id" uuid,
	"training_summary" text,
	"ai_critique" text,
	"final_strategy" text,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_training_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"training_session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_playbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"campaign_thesis" text,
	"buyer_persona" text,
	"target_pains" text,
	"value_proposition" text,
	"primary_hook" text,
	"primary_cta" text,
	"objection_map" jsonb,
	"allowed_claims" text,
	"prohibited_claims" text,
	"handoff_rules" text,
	"exit_rules" text,
	"ai_operating_instructions" text,
	"approval_status" text DEFAULT 'draft' NOT NULL,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_demo_guides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"demo_goal" text,
	"pre_call_confirmation_template" text,
	"call_agenda" text,
	"discovery_questions" jsonb,
	"demo_flow" jsonb,
	"qualification_questions" jsonb,
	"post_call_followup_template" text,
	"proposal_request_checklist" jsonb,
	"handoff_summary_template" text,
	"approval_status" text DEFAULT 'draft' NOT NULL,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_exit_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"max_email_attempts" integer DEFAULT 5 NOT NULL,
	"max_days_in_sequence" integer DEFAULT 14 NOT NULL,
	"max_no_reply_followups" integer DEFAULT 4 NOT NULL,
	"stop_on_unsubscribe" boolean DEFAULT true NOT NULL,
	"stop_on_hard_bounce" boolean DEFAULT true NOT NULL,
	"stop_on_not_interested" boolean DEFAULT true NOT NULL,
	"stop_on_wrong_person_without_referral" boolean DEFAULT true NOT NULL,
	"stop_on_bad_fit" boolean DEFAULT true NOT NULL,
	"pause_on_out_of_office" boolean DEFAULT true NOT NULL,
	"out_of_office_resume_days" integer DEFAULT 7 NOT NULL,
	"stop_if_no_reply_after_breakup" boolean DEFAULT true NOT NULL,
	"reactivation_allowed" boolean DEFAULT true NOT NULL,
	"reactivation_after_days" integer DEFAULT 90 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_test_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"scenario_name" text,
	"simulated_reply" text,
	"expected_classification" text,
	"ai_response" text,
	"should_auto_reply" boolean,
	"should_handoff" boolean,
	"should_stop" boolean,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "suppression_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"reason" text,
	"source" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "domain_health_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"gmail_account_id" uuid,
	"domain" text NOT NULL,
	"spf_status" text,
	"dkim_status" text,
	"dmarc_status" text,
	"mx_status" text,
	"bounce_rate" numeric(5, 4),
	"unsubscribe_rate" numeric(5, 4),
	"reply_rate" numeric(5, 4),
	"send_volume" integer,
	"health_score" integer,
	"recommendation" text,
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_ai_profiles" ADD CONSTRAINT "workspace_ai_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gmail_accounts" ADD CONSTRAINT "gmail_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_gmail_account_id_gmail_accounts_id_fk" FOREIGN KEY ("gmail_account_id") REFERENCES "public"."gmail_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_goals" ADD CONSTRAINT "campaign_goals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_goals" ADD CONSTRAINT "campaign_goals_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_knowledge_files" ADD CONSTRAINT "campaign_knowledge_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_knowledge_files" ADD CONSTRAINT "campaign_knowledge_files_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_lead_sources" ADD CONSTRAINT "campaign_lead_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_lead_sources" ADD CONSTRAINT "campaign_lead_sources_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leads" ADD CONSTRAINT "leads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leads" ADD CONSTRAINT "leads_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leads" ADD CONSTRAINT "leads_gmail_account_id_gmail_accounts_id_fk" FOREIGN KEY ("gmail_account_id") REFERENCES "public"."gmail_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_gmail_account_id_gmail_accounts_id_fk" FOREIGN KEY ("gmail_account_id") REFERENCES "public"."gmail_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_email_thread_id_email_threads_id_fk" FOREIGN KEY ("email_thread_id") REFERENCES "public"."email_threads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_email_thread_id_email_threads_id_fk" FOREIGN KEY ("email_thread_id") REFERENCES "public"."email_threads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_training_sessions" ADD CONSTRAINT "campaign_training_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_training_sessions" ADD CONSTRAINT "campaign_training_sessions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_training_sessions" ADD CONSTRAINT "campaign_training_sessions_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_training_messages" ADD CONSTRAINT "campaign_training_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_training_messages" ADD CONSTRAINT "campaign_training_messages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_training_messages" ADD CONSTRAINT "campaign_training_messages_training_session_id_campaign_training_sessions_id_fk" FOREIGN KEY ("training_session_id") REFERENCES "public"."campaign_training_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_playbooks" ADD CONSTRAINT "campaign_playbooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_playbooks" ADD CONSTRAINT "campaign_playbooks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_demo_guides" ADD CONSTRAINT "campaign_demo_guides_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_demo_guides" ADD CONSTRAINT "campaign_demo_guides_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_exit_rules" ADD CONSTRAINT "campaign_exit_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_exit_rules" ADD CONSTRAINT "campaign_exit_rules_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_test_scenarios" ADD CONSTRAINT "campaign_test_scenarios_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaign_test_scenarios" ADD CONSTRAINT "campaign_test_scenarios_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_list_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domain_health_checks" ADD CONSTRAINT "domain_health_checks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domain_health_checks" ADD CONSTRAINT "domain_health_checks_gmail_account_id_gmail_accounts_id_fk" FOREIGN KEY ("gmail_account_id") REFERENCES "public"."gmail_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_active_idx" ON "workspaces" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_unique" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_ai_profiles_workspace_idx" ON "workspace_ai_profiles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gmail_accounts_workspace_idx" ON "gmail_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gmail_accounts_workspace_email_unique" ON "gmail_accounts" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gmail_accounts_active_idx" ON "gmail_accounts" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_workspace_idx" ON "campaigns" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_workspace_status_idx" ON "campaigns" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_goals_workspace_idx" ON "campaign_goals" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_goals_campaign_idx" ON "campaign_goals" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_knowledge_files_workspace_idx" ON "campaign_knowledge_files" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_knowledge_files_campaign_idx" ON "campaign_knowledge_files" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_knowledge_files_extraction_status_idx" ON "campaign_knowledge_files" USING btree ("extraction_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_lead_sources_workspace_idx" ON "campaign_lead_sources" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_lead_sources_campaign_idx" ON "campaign_lead_sources" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_workspace_idx" ON "leads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_workspace_status_idx" ON "leads" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_campaign_idx" ON "leads" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_gmail_thread_idx" ON "leads" USING btree ("gmail_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leads_unique_email_per_campaign" ON "leads" USING btree ("workspace_id",LOWER("email"),"campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_next_action_active_idx" ON "leads" USING btree ("next_action_at") WHERE "leads"."lifecycle_status" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_threads_workspace_idx" ON "email_threads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_threads_gmail_thread_idx" ON "email_threads" USING btree ("gmail_thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_threads_lead_idx" ON "email_threads" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_messages_workspace_idx" ON "email_messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_messages_gmail_message_idx" ON "email_messages" USING btree ("gmail_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_messages_gmail_thread_idx" ON "email_messages" USING btree ("gmail_thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_messages_thread_idx" ON "email_messages" USING btree ("email_thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_actions_workspace_idx" ON "ai_actions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_actions_queue_idx" ON "ai_actions" USING btree ("status","action_type","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_actions_lead_idx" ON "ai_actions" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_training_sessions_workspace_idx" ON "campaign_training_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_training_sessions_campaign_idx" ON "campaign_training_sessions" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_training_messages_session_idx" ON "campaign_training_messages" USING btree ("training_session_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_playbooks_workspace_idx" ON "campaign_playbooks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_playbooks_campaign_idx" ON "campaign_playbooks" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_demo_guides_workspace_idx" ON "campaign_demo_guides" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_demo_guides_campaign_idx" ON "campaign_demo_guides" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_exit_rules_workspace_idx" ON "campaign_exit_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_exit_rules_campaign_idx" ON "campaign_exit_rules" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_test_scenarios_workspace_idx" ON "campaign_test_scenarios" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_test_scenarios_campaign_idx" ON "campaign_test_scenarios" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppression_list_workspace_idx" ON "suppression_list" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "suppression_list_unique_email" ON "suppression_list" USING btree ("workspace_id",LOWER("email"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "domain_health_checks_workspace_idx" ON "domain_health_checks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "domain_health_checks_gmail_idx" ON "domain_health_checks" USING btree ("gmail_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "domain_health_checks_domain_idx" ON "domain_health_checks" USING btree ("domain");