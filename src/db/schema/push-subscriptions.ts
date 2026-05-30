import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';

// Device push targets per user. For Capacitor/FCM the deviceToken holds the
// FCM registration token (platform 'android-fcm'). The endpoint/p256dh/auth
// columns are reserved for a future Web Push fallback (platform 'web-push').
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceToken: text('device_token'), // FCM registration token
    endpoint: text('endpoint'), // Web Push (future)
    p256dhKey: text('p256dh_key'),
    authKey: text('auth_key'),
    deviceLabel: text('device_label'),
    platform: text('platform').notNull(), // 'android-fcm' | 'web-push'
    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    tokenUnique: uniqueIndex('push_sub_user_token_unique').on(t.userId, t.deviceToken),
  }),
);

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;
