import { pgTable, uuid, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';

export const campaignExitRules = pgTable(
  'campaign_exit_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),

    maxEmailAttempts: integer('max_email_attempts').notNull().default(5),
    maxDaysInSequence: integer('max_days_in_sequence').notNull().default(14),
    maxNoReplyFollowups: integer('max_no_reply_followups').notNull().default(4),

    stopOnUnsubscribe: boolean('stop_on_unsubscribe').notNull().default(true),
    stopOnHardBounce: boolean('stop_on_hard_bounce').notNull().default(true),
    stopOnNotInterested: boolean('stop_on_not_interested').notNull().default(true),
    stopOnWrongPersonWithoutReferral: boolean('stop_on_wrong_person_without_referral').notNull().default(true),
    stopOnBadFit: boolean('stop_on_bad_fit').notNull().default(true),

    pauseOnOutOfOffice: boolean('pause_on_out_of_office').notNull().default(true),
    outOfOfficeResumeDays: integer('out_of_office_resume_days').notNull().default(7),

    stopIfNoReplyAfterBreakup: boolean('stop_if_no_reply_after_breakup').notNull().default(true),

    reactivationAllowed: boolean('reactivation_allowed').notNull().default(true),
    reactivationAfterDays: integer('reactivation_after_days').notNull().default(90),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('campaign_exit_rules_workspace_idx').on(t.workspaceId),
    campaignIdx: index('campaign_exit_rules_campaign_idx').on(t.campaignId),
  }),
);

export type CampaignExitRules = typeof campaignExitRules.$inferSelect;
export type NewCampaignExitRules = typeof campaignExitRules.$inferInsert;
