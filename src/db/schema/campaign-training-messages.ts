import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';
import { campaignTrainingSessions } from './campaign-training-sessions';

// role values: 'user' | 'assistant' | 'system'
export const campaignTrainingMessages = pgTable(
  'campaign_training_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
    trainingSessionId: uuid('training_session_id')
      .notNull()
      .references(() => campaignTrainingSessions.id),

    role: text('role').notNull(),
    message: text('message').notNull(),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: index('campaign_training_messages_session_idx').on(t.trainingSessionId, t.createdAt),
  }),
);

export type CampaignTrainingMessage = typeof campaignTrainingMessages.$inferSelect;
export type NewCampaignTrainingMessage = typeof campaignTrainingMessages.$inferInsert;
