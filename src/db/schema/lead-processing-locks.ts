import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { leads } from './leads';

// Coordination table for fire-and-forget background runners (the post-intake
// runner is the first user). Prevents duplicate notes / tasks / activities
// when a retry fires while the original run is still in flight, or when an
// AT-LEAST-ONCE queue redelivers a message.
//
// Usage pattern in the runner:
//   1. INSERT a row with status='running'. The unique (lead_id, process_name)
//      constraint causes the INSERT to fail if a sibling is already running.
//   2. Do the work.
//   3. UPDATE row to status='completed' + set leads.post_intake_processed_at.
//   4. On failure: UPDATE row to status='failed' so a manual retry tool can
//      clear it and re-run.
export const leadProcessingLocks = pgTable(
  'lead_processing_locks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    leadId: uuid('lead_id').notNull().references(() => leads.id),
    processName: text('process_name').notNull(),
    status: text('status').notNull().default('running'),
    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: false }),
  },
  (t) => ({
    // Hard fence: one in-flight or completed lock per (lead, process_name).
    // INSERT collides → caller knows another runner has this lead.
    uniquePerProcess: uniqueIndex('lead_processing_locks_unique').on(t.leadId, t.processName),
  }),
);

export type LeadProcessingLock = typeof leadProcessingLocks.$inferSelect;
export type NewLeadProcessingLock = typeof leadProcessingLocks.$inferInsert;
