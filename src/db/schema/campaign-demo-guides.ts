import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';

export const campaignDemoGuides = pgTable(
  'campaign_demo_guides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),

    demoGoal: text('demo_goal'),
    preCallConfirmationTemplate: text('pre_call_confirmation_template'),
    callAgenda: text('call_agenda'),
    discoveryQuestions: jsonb('discovery_questions'),
    demoFlow: jsonb('demo_flow'),
    qualificationQuestions: jsonb('qualification_questions'),
    postCallFollowupTemplate: text('post_call_followup_template'),
    proposalRequestChecklist: jsonb('proposal_request_checklist'),
    handoffSummaryTemplate: text('handoff_summary_template'),

    approvalStatus: text('approval_status').notNull().default('draft'),
    approvedAt: timestamp('approved_at', { withTimezone: false }),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('campaign_demo_guides_workspace_idx').on(t.workspaceId),
    campaignIdx: index('campaign_demo_guides_campaign_idx').on(t.campaignId),
  }),
);

export type CampaignDemoGuide = typeof campaignDemoGuides.$inferSelect;
export type NewCampaignDemoGuide = typeof campaignDemoGuides.$inferInsert;
