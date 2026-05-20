import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';
import { users } from './users';

export const campaignTrainingSessions = pgTable(
  'campaign_training_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),

    status: text('status').notNull().default('in_progress'),

    startedByUserId: uuid('started_by_user_id').references(() => users.id),

    trainingSummary: text('training_summary'),
    aiCritique: text('ai_critique'),
    finalStrategy: text('final_strategy'),

    approvedAt: timestamp('approved_at', { withTimezone: false }),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('campaign_training_sessions_workspace_idx').on(t.workspaceId),
    campaignIdx: index('campaign_training_sessions_campaign_idx').on(t.campaignId),
  }),
);

export type CampaignTrainingSession = typeof campaignTrainingSessions.$inferSelect;
export type NewCampaignTrainingSession = typeof campaignTrainingSessions.$inferInsert;
