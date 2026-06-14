import { pgTable, uuid, text, boolean, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { users } from './users';

export const gmailAccounts = pgTable(
  'gmail_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),

    email: text('email').notNull(),
    senderName: text('sender_name'),
    googleUserId: text('google_user_id'),
    connectedByUserId: uuid('connected_by_user_id').references(() => users.id),

    accessTokenEncrypted: text('access_token_encrypted'),
    refreshTokenEncrypted: text('refresh_token_encrypted'),
    tokenExpiry: timestamp('token_expiry', { withTimezone: false }),

    domain: text('domain'),
    healthStatus: text('health_status').notNull().default('unknown'),

    dailySendLimit: integer('daily_send_limit').notNull().default(25),
    dailySentCount: integer('daily_sent_count').notNull().default(0),
    // When daily_sent_count was last rolled over to 0. The followup worker
    // resets the counter once per calendar day.
    dailyCountResetAt: timestamp('daily_count_reset_at', { withTimezone: false }),
    maxNewThreadsPerDay: integer('max_new_threads_per_day').notNull().default(25),

    warmupMode: boolean('warmup_mode').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),

    lastSyncAt: timestamp('last_sync_at', { withTimezone: false }),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('gmail_accounts_workspace_idx').on(t.workspaceId),
    workspaceEmailUnique: uniqueIndex('gmail_accounts_workspace_email_unique').on(t.workspaceId, t.email),
    activeIdx: index('gmail_accounts_active_idx').on(t.isActive),
    connectedByIdx: index('gmail_accounts_connected_by_idx').on(t.connectedByUserId),
  }),
);

export type GmailAccount = typeof gmailAccounts.$inferSelect;
export type NewGmailAccount = typeof gmailAccounts.$inferInsert;
