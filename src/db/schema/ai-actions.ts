import { pgTable, uuid, text, numeric, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';
import { leads } from './leads';
import { emailThreads } from './email-threads';

// Also serves as the AI job queue: workers SELECT ... FOR UPDATE SKIP LOCKED
// where status='pending' AND action_type IN (...)
export const aiActions = pgTable(
  'ai_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    campaignId: uuid('campaign_id').references(() => campaigns.id),
    leadId: uuid('lead_id').references(() => leads.id),
    emailThreadId: uuid('email_thread_id').references(() => emailThreads.id),

    actionType: text('action_type'),
    status: text('status'),

    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    reason: text('reason'),
    aiOutput: jsonb('ai_output'),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: false }),
  },
  (t) => ({
    workspaceIdx: index('ai_actions_workspace_idx').on(t.workspaceId),
    // Queue scan: status + action_type + created_at FIFO
    queueIdx: index('ai_actions_queue_idx').on(t.status, t.actionType, t.createdAt),
    leadIdx: index('ai_actions_lead_idx').on(t.leadId),
  }),
);

export type AiAction = typeof aiActions.$inferSelect;
export type NewAiAction = typeof aiActions.$inferInsert;

export const AI_ACTION_TYPES = [
  'score_lead',
  'generate_email',
  'classify_reply',
  'generate_reply',
  'create_draft',
  'send_email',
  'handoff',
  'stop_sequence',
  'pause_lead',
  'generate_playbook',
  'generate_demo_guide',
  'summarize_thread',
  'extract_knowledge',
  'summarize_knowledge',
] as const;
export type AiActionType = (typeof AI_ACTION_TYPES)[number];

export const AI_ACTION_STATUSES = ['pending', 'processing', 'completed', 'failed', 'cancelled'] as const;
export type AiActionStatus = (typeof AI_ACTION_STATUSES)[number];
