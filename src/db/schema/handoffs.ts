import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';
import { leads } from './leads';
import { emailThreads } from './email-threads';

// A handoff is a dedicated record (not just a lead flag) so it can carry a
// due date, operator notes, an assignee, and a resolution history. Creating a
// handoff also flips the linked lead to status='handoff_required'; resolving
// it flips the lead back — that lead-sync lives in handoff.service.ts.
export const handoffs = pgTable(
  'handoffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    leadId: uuid('lead_id').notNull().references(() => leads.id),
    campaignId: uuid('campaign_id').references(() => campaigns.id),
    emailThreadId: uuid('email_thread_id').references(() => emailThreads.id),

    // open | in_progress | resolved | dismissed
    status: text('status').notNull().default('open'),
    // why it was escalated (AI classification reason or operator text)
    reason: text('reason'),
    // free-form operator notes
    notes: text('notes'),
    dueDate: timestamp('due_date', { withTimezone: false }),
    // operator email the handoff is assigned to (nullable)
    assignee: text('assignee'),
    // continue | closed | <free text> — set on resolve
    resolution: text('resolution'),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: false }),
  },
  (t) => ({
    workspaceIdx: index('handoffs_workspace_idx').on(t.workspaceId),
    leadIdx: index('handoffs_lead_idx').on(t.leadId),
    workspaceStatusIdx: index('handoffs_workspace_status_idx').on(t.workspaceId, t.status),
  }),
);

export type Handoff = typeof handoffs.$inferSelect;
export type NewHandoff = typeof handoffs.$inferInsert;

export const HANDOFF_STATUSES = ['open', 'in_progress', 'resolved', 'dismissed'] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];
