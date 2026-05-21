import { pgTable, uuid, text, boolean, numeric, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

// Per-workspace handoff trigger. The AI checks these conditions when classifying
// inbound replies; any match → flip lead to handoff_required + ai_owner=false.
// Stored as a JSONB array so users can add / remove / edit / toggle each rule
// from Settings without a migration.
export type HandoffRule = {
  id: string;
  text: string;
  enabled: boolean;
  isDefault: boolean;
  // 'info' | 'warning' | 'danger' — UI tone, not load-bearing on the AI side.
  tone?: 'info' | 'warning' | 'danger';
};

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    name: text('name').notNull(),
    companyName: text('company_name').notNull(),
    brandName: text('brand_name'),
    industry: text('industry'),
    website: text('website'),

    defaultFromEmail: text('default_from_email'),
    defaultSenderName: text('default_sender_name'),
    defaultBookingLink: text('default_booking_link'),
    notificationEmail: text('notification_email'),

    crmType: text('crm_type').notNull().default('internal'),

    autoReplyEnabled: boolean('auto_reply_enabled').notNull().default(false),
    autoReplyConfidenceThreshold: numeric('auto_reply_confidence_threshold', {
      precision: 4,
      scale: 3,
    }).notNull().default('0.850'),

    handoffRules: jsonb('handoff_rules').$type<HandoffRule[]>().notNull().default([]),

    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    activeIdx: index('workspaces_active_idx').on(t.isActive),
  }),
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
