import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { leads } from './leads';
import { aiActions } from './ai-actions';
import { users } from './users';

// Per-lead notes — manual operator notes and AI-generated summaries. The AI
// writes notes during the post-intake runner (intake_summary), reply triage
// (reply_summary), meeting prep, objection flags, handoff briefs, and
// post-call recaps.
//
// Notes are *separate* from activities: activities are an event log (one row
// per thing that happened); notes are content (paragraphs the operator and
// AI write to one another). Every note insert also writes a paired
// `note_created` activity row so the Activity tab stays the single source of
// truth for "what happened, when".
export const salesNotes = pgTable(
  'sales_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    leadId: uuid('lead_id').notNull().references(() => leads.id),

    kind: text('kind').notNull(),
    title: text('title'),
    body: text('body').notNull(),

    authorUserId: uuid('author_user_id').references(() => users.id),
    aiActionId: uuid('ai_action_id').references(() => aiActions.id),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceLeadCreatedIdx: index('sales_notes_workspace_lead_created_idx').on(
      t.workspaceId,
      t.leadId,
      t.createdAt,
    ),
  }),
);

export type SalesNote = typeof salesNotes.$inferSelect;
export type NewSalesNote = typeof salesNotes.$inferInsert;

export const SALES_NOTE_KINDS = [
  'manual',
  'ai_summary',
  'reply_summary',
  'meeting_prep',
  'objection',
  'handoff',
  'post_call',
  'intake_summary',
] as const;
export type SalesNoteKind = (typeof SALES_NOTE_KINDS)[number];
