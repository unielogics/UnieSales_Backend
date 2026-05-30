import { pgTable, uuid, text, numeric, jsonb, timestamp, integer, index } from 'drizzle-orm/pg-core';
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

    // Anthropic token accounting (from response.usage) — lets us measure
    // per-task spend and prompt-cache hit rate. Nullable: legacy rows + tasks
    // that don't go through runAction won't have these.
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheCreationTokens: integer('cache_creation_tokens'),

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
  // Operator-directed revisions of an existing playbook / demo guide.
  // Same output shape as the generate_* tasks, different prompt: apply
  // instructions surgically rather than synthesize from scratch.
  'revise_playbook',
  'revise_demo_guide',
  'summarize_thread',
  'extract_knowledge',
  'summarize_knowledge',
  // Lead triage — temperature + intent labels. Used by the post-intake runner
  // to decide downstream actions (booking, info request, handoff, etc.).
  'classify_lead',
  // Catch-all wrapper for one full post-intake runner pass; lets us attribute
  // cost + audit one row per lead even when the runner fans out to multiple
  // sub-tasks. Score / classify / etc. still get their own rows too.
  'intake_post_process',
] as const;
export type AiActionType = (typeof AI_ACTION_TYPES)[number];

export const AI_ACTION_STATUSES = ['pending', 'processing', 'completed', 'failed', 'cancelled'] as const;
export type AiActionStatus = (typeof AI_ACTION_STATUSES)[number];
