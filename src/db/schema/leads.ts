import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';
import { gmailAccounts } from './gmail-accounts';

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    campaignId: uuid('campaign_id').references(() => campaigns.id),
    gmailAccountId: uuid('gmail_account_id').references(() => gmailAccounts.id),

    companyName: text('company_name'),
    website: text('website'),
    contactName: text('contact_name'),
    email: text('email').notNull(),
    phone: text('phone'),
    title: text('title'),
    linkedinUrl: text('linkedin_url'),

    segment: text('segment'),
    source: text('source'),
    sourceUrl: text('source_url'),
    sourceNotes: text('source_notes'),

    leadScore: integer('lead_score').notNull().default(0),
    leadScoreReason: text('lead_score_reason'),
    painAngle: text('pain_angle'),
    personalization: text('personalization'),

    status: text('status').notNull().default('new'),
    lifecycleStatus: text('lifecycle_status').notNull().default('active'),

    closeReason: text('close_reason'),
    closedAt: timestamp('closed_at', { withTimezone: false }),
    pausedUntil: timestamp('paused_until', { withTimezone: false }),

    firstContactedAt: timestamp('first_contacted_at', { withTimezone: false }),
    lastContactedAt: timestamp('last_contacted_at', { withTimezone: false }),
    lastEngagementAt: timestamp('last_engagement_at', { withTimezone: false }),
    nextActionAt: timestamp('next_action_at', { withTimezone: false }),

    emailAttemptCount: integer('email_attempt_count').notNull().default(0),
    noReplyCount: integer('no_reply_count').notNull().default(0),
    followupCount: integer('followup_count').notNull().default(0),
    reactivationEligibleAt: timestamp('reactivation_eligible_at', { withTimezone: false }),

    gmailThreadId: text('gmail_thread_id'),
    hubspotContactId: text('hubspot_contact_id'),
    sheetRowId: text('sheet_row_id'),

    aiOwner: boolean('ai_owner').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('leads_workspace_idx').on(t.workspaceId),
    workspaceStatusIdx: index('leads_workspace_status_idx').on(t.workspaceId, t.status),
    campaignIdx: index('leads_campaign_idx').on(t.campaignId),
    gmailThreadIdx: index('leads_gmail_thread_idx').on(t.gmailThreadId),
    // De-dupe per workspace+campaign on case-insensitive email
    uniqueEmailPerCampaign: uniqueIndex('leads_unique_email_per_campaign').on(
      t.workspaceId,
      sql`LOWER(${t.email})`,
      t.campaignId,
    ),
    // Followup worker scans this regularly
    nextActionActiveIdx: index('leads_next_action_active_idx')
      .on(t.nextActionAt)
      .where(sql`${t.lifecycleStatus} = 'active'`),
  }),
);

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;

export const LEAD_STATUSES = [
  'new',
  'pending_review',
  'ready_to_score',
  'scored',
  'ready_to_send',
  'sent_email_1',
  'sent_followup_1',
  'sent_followup_2',
  'sent_followup_3',
  'replied',
  'interested',
  'info_sent',
  'objection',
  'meeting_requested',
  'call_link_sent',
  'call_scheduled',
  'handoff_required',
  'paused',
  'closed_no_response',
  'closed_not_interested',
  'closed_bad_fit',
  'closed_wrong_person',
  'closed_unsubscribed',
  'closed_bounced',
  'closed_duplicate',
  'closed_manual',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
