import { pgTable, uuid, text, integer, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { gmailAccounts } from './gmail-accounts';

export const domainHealthChecks = pgTable(
  'domain_health_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    gmailAccountId: uuid('gmail_account_id').references(() => gmailAccounts.id),

    domain: text('domain').notNull(),

    spfStatus: text('spf_status'),
    dkimStatus: text('dkim_status'),
    dmarcStatus: text('dmarc_status'),
    mxStatus: text('mx_status'),

    bounceRate: numeric('bounce_rate', { precision: 5, scale: 4 }),
    unsubscribeRate: numeric('unsubscribe_rate', { precision: 5, scale: 4 }),
    replyRate: numeric('reply_rate', { precision: 5, scale: 4 }),
    sendVolume: integer('send_volume'),

    healthScore: integer('health_score'),
    recommendation: text('recommendation'),

    checkedAt: timestamp('checked_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('domain_health_checks_workspace_idx').on(t.workspaceId),
    gmailIdx: index('domain_health_checks_gmail_idx').on(t.gmailAccountId),
    domainIdx: index('domain_health_checks_domain_idx').on(t.domain),
  }),
);

export type DomainHealthCheck = typeof domainHealthChecks.$inferSelect;
export type NewDomainHealthCheck = typeof domainHealthChecks.$inferInsert;
