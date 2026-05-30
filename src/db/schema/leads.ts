import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
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
    // First and last name split out from contactName when the upstream form
    // supplied a single Name field. Forms that already send the split (e.g.
    // UnieCortex) populate these directly. The AI prompts prefer firstName
    // for greetings; contactName remains the canonical full name.
    firstName: text('first_name'),
    lastName: text('last_name'),
    email: text('email').notNull(),
    phone: text('phone'),
    title: text('title'),
    linkedinUrl: text('linkedin_url'),

    city: text('city'),
    state: text('state'),
    streetAddress: text('street_address'),
    addressFull: text('address_full'),

    segment: text('segment'),
    source: text('source'),
    sourceUrl: text('source_url'),
    sourceNotes: text('source_notes'),

    // Per-campaign custom fields — operator-defined column mappings (e.g.
    // `fleet_size`, `wms_in_use`, `revenue_range`) imported from CSV/Sheet
    // sources. Schema-less by design: each campaign decides its own keys. The
    // AI receives this map in context and may reference any value when
    // scoring, classifying, or drafting outbound copy.
    customFields: jsonb('custom_fields').$type<Record<string, string>>(),

    leadScore: integer('lead_score').notNull().default(0),
    leadScoreReason: text('lead_score_reason'),
    painAngle: text('pain_angle'),
    personalization: text('personalization'),

    status: text('status').notNull().default('new'),
    lifecycleStatus: text('lifecycle_status').notNull().default('active'),

    // Sales conversion pipeline stage (slug from pipeline_stages, or one of
    // the default seeded stages for inbound campaigns). Nullable until the
    // post-intake runner sets it. Indexed below for board/table queries.
    pipelineStage: text('pipeline_stage'),

    // Stamp set by the post-intake runner when it has completed all triage
    // work for this lead (score + classify + intake_summary note + suggested
    // next action). Used as a fast idempotency check — null means the runner
    // hasn't seen this lead yet; non-null means skip.
    postIntakeProcessedAt: timestamp('post_intake_processed_at', { withTimezone: false }),

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

    // How the lead first entered: 'upload' (a source's initial import),
    // 'update' (a later refresh of a source). Null for manual/warm-up leads.
    importOrigin: text('import_origin'),

    // Contact channel: 'email' (default) or 'sms'. Set at import: email if a
    // valid email is mapped, sms if phone-only.
    channel: text('channel').notNull().default('email'),

    aiOwner: boolean('ai_owner').notNull().default(true),

    // Soft-delete timestamp. When non-null, the lead is hidden from every
    // UI surface (inbound list, inbox, queue, calendar, pipeline) and every
    // AI worker (followup, scoring, classify) — they all filter
    // `deleted_at IS NULL`. Set via the lead bulk-delete endpoint; cleared
    // (currently no UI for un-delete, but the column is restore-friendly).
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    // Email send failure marker. Set when a Gmail send to lead.email fails
    // permanently (bounce, invalid address, etc.). Followup worker filters
    // these out — the AI never retries to a known-broken email. Reset by
    // the leads PATCH handler when `email` is updated, so a corrected
    // address is eligible again.
    emailSendFailedAt: timestamp('email_send_failed_at', { withTimezone: true }),
    emailSendFailReason: text('email_send_fail_reason'),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('leads_workspace_idx').on(t.workspaceId),
    workspaceStatusIdx: index('leads_workspace_status_idx').on(t.workspaceId, t.status),
    workspacePipelineIdx: index('leads_workspace_pipeline_idx').on(t.workspaceId, t.pipelineStage),
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
