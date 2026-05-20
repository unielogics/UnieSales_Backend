import { pgTable, uuid, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';

export const workspaceAiProfiles = pgTable(
  'workspace_ai_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),

    profileName: text('profile_name').notNull(),
    systemPrompt: text('system_prompt').notNull(),

    prohibitedClaims: text('prohibited_claims'),
    requiredDisclaimers: text('required_disclaimers'),
    toneRules: text('tone_rules'),
    handoffRules: text('handoff_rules'),
    autoReplyRules: text('auto_reply_rules'),

    isDefault: boolean('is_default').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('workspace_ai_profiles_workspace_idx').on(t.workspaceId),
  }),
);

export type WorkspaceAiProfile = typeof workspaceAiProfiles.$inferSelect;
export type NewWorkspaceAiProfile = typeof workspaceAiProfiles.$inferInsert;
