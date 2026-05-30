import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
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
    // When true the campaign is live but still in operator-driven warm-up
    // (manual sends only). Cleared by an explicit "Activate Campaign".
    warmupMode: boolean('warmup_mode').notNull().default(false),

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

    // SMS-specific config. Default null → behaves as channel_mode='auto',
    // quiet hours 20:00–09:00 in the workspace timezone.
    smsConfig: jsonb('sms_config').$type<{
      channelMode?: 'auto' | 'email_only' | 'sms_only';
      quietHoursStart?: string; // "HH:MM" in workspace tz
      quietHoursEnd?: string; // "HH:MM" in workspace tz
    }>(),

    dailySendLimit: integer('daily_send_limit').notNull().default(25),
    // 24-hour clock HH:MM strings — backend validator enforces format
    sendWindowStart: text('send_window_start').notNull().default('09:00'),
    sendWindowEnd: text('send_window_end').notNull().default('17:00'),
    weekdaysOnly: boolean('weekdays_only').notNull().default(true),
    handoffEmail: text('handoff_email'),

    gmailAccountId: uuid('gmail_account_id').references(() => gmailAccounts.id),

    // Set by the Test step's /test endpoint. Drives the "Test reviewed" check
    // in the launch checklist and the Test builder step's done state.
    lastTestedAt: timestamp('last_tested_at', { withTimezone: false }),

    // Configured at Step 11. When set + in the future, the campaign is queued
    // to auto-activate at that instant (the followup worker runs the same
    // activation gate at the scheduled time). Cleared once activation fires.
    scheduledStartAt: timestamp('scheduled_start_at', { withTimezone: false }),

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
