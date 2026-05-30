import { pgTable, uuid, text, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users';

// Per-user notification preferences. One row per user (PK = user_id).
// perKind maps a NotificationKind → boolean (default behavior is "on" when a
// kind is absent from the map). Quiet hours mute non-urgent push delivery.
export const notificationSettings = pgTable('notification_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  perKind: jsonb('per_kind').$type<Record<string, boolean>>().notNull().default({}),
  quietHoursEnabled: boolean('quiet_hours_enabled').notNull().default(true),
  quietHoursStart: text('quiet_hours_start').notNull().default('21:00'),
  quietHoursEnd: text('quiet_hours_end').notNull().default('07:00'),
  createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
});

export type NotificationSettings = typeof notificationSettings.$inferSelect;
export type NewNotificationSettings = typeof notificationSettings.$inferInsert;
