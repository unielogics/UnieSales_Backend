import { pgTable, uuid, text, boolean, numeric, timestamp, index } from 'drizzle-orm/pg-core';

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
