import { pgTable, uuid, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';

// Per-campaign AI behavior configuration — the structured rule set the
// runtime reads (post-intake runner, reply triage, follow-up scheduler) when
// deciding what to do with a lead.
//
// One row per campaign. The `cards` JSONB is a fixed-schema object with one
// key per card; each card has `{ status, summary, rule_payload }`. We never
// look up by individual card key in SQL — the whole row is loaded, mutations
// rewrite the whole jsonb.
//
// Until cards are explicitly approved, the runner falls back to safe
// defaults (Draft Only, no auto-send, conservative handoff triggers).

export type AiBehaviorCardKey =
  | 'lead_intelligence'
  | 'first_response'
  | 'email_followup'
  | 'booking_behavior'
  | 'form_behavior'
  | 'task_creation'
  | 'note_creation'
  | 'handoff'
  | 'exit_logic'
  | 'ai_safety';

export type AiBehaviorCardStatus = 'draft' | 'needs_setup' | 'approved';

export interface AiBehaviorCard {
  status: AiBehaviorCardStatus;
  summary: string;
  /** Structured rule payload read by the runtime (e.g. confidence threshold,
   *  trigger phrases). Shape varies by card; the runner code is the source of
   *  truth for what each card stores. */
  rule_payload?: Record<string, unknown>;
  generated_at?: string;
  approved_at?: string | null;
  approved_by?: string | null;
}

export type AiBehaviorCards = Partial<Record<AiBehaviorCardKey, AiBehaviorCard>>;

export const campaignAiBehavior = pgTable(
  'campaign_ai_behavior',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
    cards: jsonb('cards').$type<AiBehaviorCards>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueCampaign: uniqueIndex('campaign_ai_behavior_unique_campaign').on(t.campaignId),
  }),
);

export type CampaignAiBehavior = typeof campaignAiBehavior.$inferSelect;
export type NewCampaignAiBehavior = typeof campaignAiBehavior.$inferInsert;

export const AI_BEHAVIOR_CARD_KEYS: AiBehaviorCardKey[] = [
  'lead_intelligence',
  'first_response',
  'email_followup',
  'booking_behavior',
  'form_behavior',
  'task_creation',
  'note_creation',
  'handoff',
  'exit_logic',
  'ai_safety',
];
