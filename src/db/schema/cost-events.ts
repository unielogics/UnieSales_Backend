import { pgTable, uuid, text, numeric, jsonb, timestamp, index, uniqueIndex, boolean } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';
import { leads } from './leads';
import { emailThreads } from './email-threads';
import { emailMessages } from './email-messages';
import { aiActions } from './ai-actions';

export const COST_SOURCES = ['exact', 'estimated', 'manual_rate'] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export const costEvents = pgTable(
  'cost_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    campaignId: uuid('campaign_id').references(() => campaigns.id),
    leadId: uuid('lead_id').references(() => leads.id),
    emailThreadId: uuid('email_thread_id').references(() => emailThreads.id),
    emailMessageId: uuid('email_message_id').references(() => emailMessages.id),
    aiActionId: uuid('ai_action_id').references(() => aiActions.id),

    sourceObjectType: text('source_object_type'),
    sourceObjectId: text('source_object_id'),
    dedupeKey: text('dedupe_key').notNull(),

    provider: text('provider').notNull(),
    service: text('service').notNull(),
    category: text('category').notNull(),
    actionType: text('action_type'),
    channel: text('channel'),

    quantity: numeric('quantity', { precision: 18, scale: 6 }).notNull().default('1'),
    unit: text('unit').notNull(),
    unitCostUsd: numeric('unit_cost_usd', { precision: 18, scale: 9 }).notNull().default('0'),
    amountUsd: numeric('amount_usd', { precision: 18, scale: 9 }).notNull().default('0'),
    currency: text('currency').notNull().default('USD'),
    pricingVersion: text('pricing_version').notNull().default('default'),
    costSource: text('cost_source').$type<CostSource>().notNull().default('estimated'),

    occurredAt: timestamp('occurred_at', { withTimezone: false }).notNull().defaultNow(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceTimeIdx: index('cost_events_workspace_time_idx').on(t.workspaceId, t.occurredAt),
    campaignIdx: index('cost_events_campaign_idx').on(t.campaignId),
    leadIdx: index('cost_events_lead_idx').on(t.leadId),
    providerIdx: index('cost_events_provider_idx').on(t.provider, t.service),
    dedupeUnique: uniqueIndex('cost_events_dedupe_unique').on(t.dedupeKey),
  }),
);

export type CostEvent = typeof costEvents.$inferSelect;
export type NewCostEvent = typeof costEvents.$inferInsert;

export const costRateCards = pgTable(
  'cost_rate_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id),
    provider: text('provider').notNull(),
    service: text('service').notNull(),
    category: text('category').notNull(),
    actionType: text('action_type'),
    unit: text('unit').notNull(),
    unitCostUsd: numeric('unit_cost_usd', { precision: 18, scale: 9 }).notNull().default('0'),
    currency: text('currency').notNull().default('USD'),
    pricingVersion: text('pricing_version').notNull().default('default'),
    isActive: boolean('is_active').notNull().default(true),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    lookupIdx: index('cost_rate_cards_lookup_idx').on(
      t.workspaceId,
      t.provider,
      t.service,
      t.category,
      t.actionType,
      t.unit,
    ),
  }),
);

export type CostRateCard = typeof costRateCards.$inferSelect;
export type NewCostRateCard = typeof costRateCards.$inferInsert;
