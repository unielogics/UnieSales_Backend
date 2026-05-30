import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';
import { leads } from './leads';
import { emailThreads } from './email-threads';
import { gmailAccounts } from './gmail-accounts';

// Two-way mirror of Google Calendar events. `source` distinguishes rows the
// app created ('app'), rows the AI booked from an email ('ai_booked'), and
// rows pulled from the operator's real Google Calendar ('google').
export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    gmailAccountId: uuid('gmail_account_id').notNull().references(() => gmailAccounts.id),

    leadId: uuid('lead_id').references(() => leads.id),
    campaignId: uuid('campaign_id').references(() => campaigns.id),
    emailThreadId: uuid('email_thread_id').references(() => emailThreads.id),

    googleEventId: text('google_event_id'),
    googleCalendarId: text('google_calendar_id').notNull().default('primary'),

    title: text('title').notNull(),
    description: text('description'),
    startAt: timestamp('start_at', { withTimezone: false }).notNull(),
    endAt: timestamp('end_at', { withTimezone: false }).notNull(),
    attendees: jsonb('attendees'),
    meetLink: text('meet_link'),
    location: text('location'),

    // confirmed | tentative | cancelled
    status: text('status').notNull().default('confirmed'),
    // app | google | ai_booked
    source: text('source').notNull().default('app'),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('calendar_events_workspace_idx').on(t.workspaceId),
    workspaceStartIdx: index('calendar_events_workspace_start_idx').on(t.workspaceId, t.startAt),
    googleUnique: uniqueIndex('calendar_events_google_unique').on(t.gmailAccountId, t.googleEventId),
  }),
);

export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type NewCalendarEvent = typeof calendarEvents.$inferInsert;

export interface CalendarAttendee {
  email: string;
  name?: string;
  responseStatus?: string;
}
