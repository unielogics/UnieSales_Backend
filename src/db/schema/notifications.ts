import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { users } from './users';
import { leads } from './leads';

// Append-only feed of business events the operator should see — handoffs,
// bookings, drafts awaiting approval, replies, won/lost, risk, daily summary.
// Powers the mobile Alerts tab + Today "What's happening" feed, and triggers
// FCM push (see notification.service).
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // null = workspace-wide (all members see it). Set = targeted at one user.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // handoff|booking|draft|reply|objection|won|lost|score|risk|summary
    priority: text('priority').notNull().default('normal'), // urgent|high|normal|low
    title: text('title').notNull(),
    body: text('body'),
    meta: text('meta'), // short context line, e.g. "22m ago · UnieLogics · WMS Audit"
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    threadId: uuid('thread_id'), // no FK — threads come and go; deep-link only
    readAt: timestamp('read_at', { withTimezone: false }),
    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceCreatedIdx: index('notif_workspace_created_idx').on(t.workspaceId, t.createdAt),
    userIdx: index('notif_user_idx').on(t.userId, t.createdAt),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

export const NOTIFICATION_KINDS = [
  'handoff', 'booking', 'draft', 'reply', 'objection',
  'won', 'lost', 'score', 'risk', 'summary',
  'deal_risk', 'task',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];
