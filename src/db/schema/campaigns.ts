import { pgTable, uuid, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { gmailAccounts } from './gmail-accounts';

// status values per spec:
//   draft, needs_training, training_in_progress, needs_review,
//   ready_to_activate, active, paused, archived
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),

    name: text('name').notNull(),
    campaignType: text('campaign_type'),

    status: text('status').notNull().default('draft'),

    targetAudience: text('target_audience'),
    offer: text('offer'),
    goalSummary: text('goal_summary'),
    primaryCta: text('primary_cta'),

    aiPositioning: text('ai_positioning'),
    aiRules: text('ai_rules'),

    safeAutoReplyRules: jsonb('safe_auto_reply_rules'),
    handoffRules: jsonb('handoff_rules'),

    maxFollowups: integer('max_followups').notNull().default(4),
    followupSchedule: jsonb('followup_schedule'),

    dailySendLimit: integer('daily_send_limit').notNull().default(25),

    gmailAccountId: uuid('gmail_account_id').references(() => gmailAccounts.id),

    // Set by the Test step's /test endpoint. Drives the "Test reviewed" check
    // in the launch checklist and the Test builder step's done state.
    lastTestedAt: timestamp('last_tested_at', { withTimezone: false }),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('campaigns_workspace_idx').on(t.workspaceId),
    workspaceStatusIdx: index('campaigns_workspace_status_idx').on(t.workspaceId, t.status),
  }),
);

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;

export const CAMPAIGN_STATUSES = [
  'draft',
  'needs_training',
  'training_in_progress',
  'needs_review',
  'ready_to_activate',
  'active',
  'paused',
  'archived',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
