import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';

export const campaignPlaybooks = pgTable(
  'campaign_playbooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),

    campaignThesis: text('campaign_thesis'),
    buyerPersona: text('buyer_persona'),
    targetPains: text('target_pains'),
    valueProposition: text('value_proposition'),
    primaryHook: text('primary_hook'),
    primaryCta: text('primary_cta'),

    objectionMap: jsonb('objection_map'),

    allowedClaims: text('allowed_claims'),
    prohibitedClaims: text('prohibited_claims'),

    handoffRules: text('handoff_rules'),
    exitRules: text('exit_rules'),

    aiOperatingInstructions: text('ai_operating_instructions'),

    approvalStatus: text('approval_status').notNull().default('draft'),
    approvedAt: timestamp('approved_at', { withTimezone: false }),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('campaign_playbooks_workspace_idx').on(t.workspaceId),
    campaignIdx: index('campaign_playbooks_campaign_idx').on(t.campaignId),
  }),
);

export type CampaignPlaybook = typeof campaignPlaybooks.$inferSelect;
export type NewCampaignPlaybook = typeof campaignPlaybooks.$inferInsert;
