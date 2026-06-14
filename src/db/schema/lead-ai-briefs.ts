import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { leads } from './leads';
import { users } from './users';
import { salesTrainingProfiles } from './sales-training';
import { aiActions } from './ai-actions';

export type LeadAiBriefSequenceState =
  | 'draft'
  | 'approved'
  | 'followup_1'
  | 'followup_2'
  | 'followup_3'
  | 'complete'
  | 'paused';

export interface LeadAiClarifyingQuestion {
  id: string;
  question: string;
  answer?: string | null;
  priority?: 'low' | 'medium' | 'high';
}

export interface LeadAiProductSuggestion {
  id: string;
  profileId: string;
  reason: string;
  status: 'pending' | 'approved' | 'dismissed';
}

export const leadAiBriefs = pgTable(
  'lead_ai_briefs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    primaryProductProfileId: uuid('primary_product_profile_id').references(() => salesTrainingProfiles.id),
    relatedProductProfileIds: jsonb('related_product_profile_ids').$type<string[]>().notNull().default([]),

    objective: text('objective'),
    operatorContext: text('operator_context'),
    constraints: text('constraints'),
    nextStep: text('next_step'),

    clarifyingQuestions: jsonb('clarifying_questions').$type<LeadAiClarifyingQuestion[]>().notNull().default([]),
    productSuggestions: jsonb('product_suggestions').$type<LeadAiProductSuggestion[]>().notNull().default([]),
    sequenceState: text('sequence_state').$type<LeadAiBriefSequenceState>().notNull().default('draft'),

    firstDraftActionId: uuid('first_draft_action_id').references(() => aiActions.id),
    approvedAt: timestamp('approved_at', { withTimezone: false }),
    lastGeneratedAt: timestamp('last_generated_at', { withTimezone: false }),
    createdBy: uuid('created_by').references(() => users.id),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceLeadUnique: uniqueIndex('lead_ai_briefs_workspace_lead_unique').on(t.workspaceId, t.leadId),
    workspaceIdx: index('lead_ai_briefs_workspace_idx').on(t.workspaceId),
    leadIdx: index('lead_ai_briefs_lead_idx').on(t.leadId),
    sequenceIdx: index('lead_ai_briefs_sequence_idx').on(t.sequenceState, t.approvedAt),
  }),
);

export type LeadAiBrief = typeof leadAiBriefs.$inferSelect;
export type NewLeadAiBrief = typeof leadAiBriefs.$inferInsert;
