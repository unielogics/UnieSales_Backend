import { pgTable, uuid, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';

export const campaignTestScenarios = pgTable(
  'campaign_test_scenarios',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),

    scenarioName: text('scenario_name'),
    simulatedReply: text('simulated_reply'),
    expectedClassification: text('expected_classification'),
    aiResponse: text('ai_response'),

    shouldAutoReply: boolean('should_auto_reply'),
    shouldHandoff: boolean('should_handoff'),
    shouldStop: boolean('should_stop'),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('campaign_test_scenarios_workspace_idx').on(t.workspaceId),
    campaignIdx: index('campaign_test_scenarios_campaign_idx').on(t.campaignId),
  }),
);

export type CampaignTestScenario = typeof campaignTestScenarios.$inferSelect;
export type NewCampaignTestScenario = typeof campaignTestScenarios.$inferInsert;
