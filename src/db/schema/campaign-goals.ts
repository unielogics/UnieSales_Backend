import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';

export const campaignGoals = pgTable(
  'campaign_goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),

    primaryGoal: text('primary_goal').notNull(),
    secondaryGoal: text('secondary_goal'),
    primaryCta: text('primary_cta').notNull(),

    successDefinition: text('success_definition'),
    qualifiedReplyDefinition: text('qualified_reply_definition'),
    targetAudience: text('target_audience'),
    offerSummary: text('offer_summary'),

    allowedClaims: text('allowed_claims'),
    prohibitedClaims: text('prohibited_claims'),
    handoffTriggers: text('handoff_triggers'),
    autoReplyBoundaries: text('auto_reply_boundaries'),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('campaign_goals_workspace_idx').on(t.workspaceId),
    campaignIdx: index('campaign_goals_campaign_idx').on(t.campaignId),
  }),
);

export type CampaignGoal = typeof campaignGoals.$inferSelect;
export type NewCampaignGoal = typeof campaignGoals.$inferInsert;
