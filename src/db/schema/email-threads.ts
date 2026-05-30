import { pgTable, uuid, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';
import { leads } from './leads';
import { gmailAccounts } from './gmail-accounts';

export const emailThreads = pgTable(
  'email_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    campaignId: uuid('campaign_id').references(() => campaigns.id),
    leadId: uuid('lead_id').references(() => leads.id),
    gmailAccountId: uuid('gmail_account_id').references(() => gmailAccounts.id),

    // Email threads carry Gmail's thread id; SMS conversations don't have one.
    gmailThreadId: text('gmail_thread_id'),
    latestGmailMessageId: text('latest_gmail_message_id'),
    subject: text('subject'),

    // 'email' (default) or 'sms'. SMS threads have one row per lead.
    channel: text('channel').notNull().default('email'),

    status: text('status').notNull().default('active'),
    aiOwner: boolean('ai_owner').notNull().default(true),

    // Operator-controlled soft-drop. When set, the thread disappears from
    // the Inbox view. The Gmail message + lead row are untouched — this is
    // purely a UnieSales-side dismissal. Cleared if the operator restores
    // (no UI for that yet; backend supports it).
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),

    lastInboundAt: timestamp('last_inbound_at', { withTimezone: false }),
    lastOutboundAt: timestamp('last_outbound_at', { withTimezone: false }),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('email_threads_workspace_idx').on(t.workspaceId),
    gmailThreadIdx: index('email_threads_gmail_thread_idx').on(t.gmailThreadId),
    leadIdx: index('email_threads_lead_idx').on(t.leadId),
  }),
);

export type EmailThread = typeof emailThreads.$inferSelect;
export type NewEmailThread = typeof emailThreads.$inferInsert;
