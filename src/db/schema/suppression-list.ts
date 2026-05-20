import { pgTable, uuid, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from './workspaces';

export const suppressionList = pgTable(
  'suppression_list',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),

    email: text('email').notNull(),
    reason: text('reason'),
    source: text('source'),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('suppression_list_workspace_idx').on(t.workspaceId),
    uniqueEmailPerWorkspace: uniqueIndex('suppression_list_unique_email').on(
      t.workspaceId,
      sql`LOWER(${t.email})`,
    ),
  }),
);

export type SuppressionListEntry = typeof suppressionList.$inferSelect;
export type NewSuppressionListEntry = typeof suppressionList.$inferInsert;
