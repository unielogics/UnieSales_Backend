import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { leads } from './leads';
import { users } from './users';

// Queued work for the human operator — both AI-suggested and manually
// created. The AI's post-intake runner creates `review_ai_draft` and
// `request_missing_info` tasks; the operator picks them off the queue from
// the Cockpit / Tasks page.
//
// `type` is plain text so adding a new task type doesn't require DDL.
export const salesTasks = pgTable(
  'sales_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    leadId: uuid('lead_id').references(() => leads.id),

    title: text('title').notNull(),
    type: text('type').notNull(),

    // 'low' | 'med' | 'high' — UI sorts high to the top
    priority: text('priority').notNull().default('med'),

    // 'open' | 'completed' | 'snoozed'
    status: text('status').notNull().default('open'),

    dueAt: timestamp('due_at', { withTimezone: false }),

    // 'manual' | 'AI' — origin attribution for the Cockpit "AI-queued" badge
    source: text('source').notNull().default('manual'),

    ownerUserId: uuid('owner_user_id').references(() => users.id),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: false }),

    // Set when the notifications worker has pushed a "task due" alert, so we
    // don't re-notify the same task every tick.
    dueNotifiedAt: timestamp('due_notified_at', { withTimezone: false }),
  },
  (t) => ({
    workspaceStatusIdx: index('sales_tasks_workspace_status_idx').on(t.workspaceId, t.status),
    // "Open tasks for this lead" — used by the lead modal's Intelligence tab.
    leadStatusIdx: index('sales_tasks_lead_status_idx').on(t.leadId, t.status),
    // "What's due next" — for upcoming-task widgets.
    ownerDueIdx: index('sales_tasks_owner_due_idx').on(t.ownerUserId, t.dueAt),
  }),
);

export type SalesTask = typeof salesTasks.$inferSelect;
export type NewSalesTask = typeof salesTasks.$inferInsert;

export const SALES_TASK_TYPES = [
  'review_lead',
  'call_lead',
  'review_ai_draft',
  'prepare_demo',
  'send_proposal',
  'request_missing_info',
  'follow_up_manual',
  'review_form_submission',
  'post_call_outcome',
  // Used by the post-intake runner when the matching Sales Training profile
  // is disabled — the AI defers to the operator instead of drafting a reply.
  'human_handoff',
] as const;
export type SalesTaskType = (typeof SALES_TASK_TYPES)[number];

export const SALES_TASK_PRIORITIES = ['low', 'med', 'high'] as const;
export type SalesTaskPriority = (typeof SALES_TASK_PRIORITIES)[number];

export const SALES_TASK_STATUSES = ['open', 'completed', 'snoozed'] as const;
export type SalesTaskStatus = (typeof SALES_TASK_STATUSES)[number];
