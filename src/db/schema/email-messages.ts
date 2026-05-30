import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';
import { leads } from './leads';
import { emailThreads } from './email-threads';

// direction per spec: inbound, outbound, draft
export const emailMessages = pgTable(
  'email_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    campaignId: uuid('campaign_id').references(() => campaigns.id),
    leadId: uuid('lead_id').references(() => leads.id),
    emailThreadId: uuid('email_thread_id').references(() => emailThreads.id),

    gmailMessageId: text('gmail_message_id'),
    gmailThreadId: text('gmail_thread_id'),
    /** Twilio MessageSid for SMS messages; null for email. */
    twilioMessageSid: text('twilio_message_sid'),

    /** 'email' (default) or 'sms'. */
    channel: text('channel').notNull().default('email'),

    direction: text('direction'),

    fromEmail: text('from_email'),
    toEmail: text('to_email'),
    subject: text('subject'),
    body: text('body'),

    aiClassification: text('ai_classification'),
    aiSummary: text('ai_summary'),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('email_messages_workspace_idx').on(t.workspaceId),
    gmailMessageIdx: index('email_messages_gmail_message_idx').on(t.gmailMessageId),
    gmailThreadIdx: index('email_messages_gmail_thread_idx').on(t.gmailThreadId),
    threadIdx: index('email_messages_thread_idx').on(t.emailThreadId),
  }),
);

export type EmailMessage = typeof emailMessages.$inferSelect;
export type NewEmailMessage = typeof emailMessages.$inferInsert;
export const EMAIL_DIRECTIONS = ['inbound', 'outbound', 'draft'] as const;
export type EmailDirection = (typeof EMAIL_DIRECTIONS)[number];
