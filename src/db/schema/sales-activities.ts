import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';
import { leads } from './leads';

// Append-only audit trail of everything that happens to a lead. Pipeline
// transitions, AI scoring, note + task creation, bookings, handoffs — they
// all write a row here so the operator can reconstruct what the AI did and
// when.
//
// `activity_type` is plain text (not a postgres enum) so adding new event
// kinds doesn't require a migration. The runtime services keep a constant
// list of supported types.
export const salesActivities = pgTable(
  'sales_activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    leadId: uuid('lead_id').references(() => leads.id),
    campaignId: uuid('campaign_id').references(() => campaigns.id),

    activityType: text('activity_type').notNull(),
    title: text('title'),
    description: text('description'),

    // Structured payload specific to the activity_type — e.g. stage_changed
    // stores `{ from: '...', to: '...' }`; ai_scored stores `{ score: 73 }`.
    metadata: jsonb('metadata').notNull().default('{}'),

    // 'system' | 'ai' | <user_id> — who attributed the event.
    createdBy: text('created_by').notNull().default('system'),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    // Primary access pattern: "give me the timeline of this lead".
    workspaceLeadCreatedIdx: index('sales_activities_workspace_lead_created_idx').on(
      t.workspaceId,
      t.leadId,
      t.createdAt,
    ),
    // Secondary: workspace-wide feeds (Activity tab, audit dashboards).
    workspaceCreatedIdx: index('sales_activities_workspace_created_idx').on(
      t.workspaceId,
      t.createdAt,
    ),
  }),
);

export type SalesActivity = typeof salesActivities.$inferSelect;
export type NewSalesActivity = typeof salesActivities.$inferInsert;

// Supported activity_type values. Plain text in the DB; the runtime uses
// this union for type-checked emit calls. Adding a new kind = append to
// this tuple — no DDL.
export const SALES_ACTIVITY_TYPES = [
  'intake_received',
  'ai_scored',
  'ai_classified',
  'note_created',
  'task_created',
  'stage_changed',
  'booking_link_sent',
  'booking_confirmed',
  'handoff_created',
  'email_drafted',
  'email_sent',
  'lead_closed',
  'meeting_outcome_logged',
] as const;
export type SalesActivityType = (typeof SALES_ACTIVITY_TYPES)[number];
