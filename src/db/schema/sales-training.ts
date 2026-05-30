import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  integer,
  timestamp,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from './workspaces';

/**
 * Sales Training — per-product AI training profiles. Operator-curated
 * knowledge that flows into every AI decision for matching inbound leads
 * (via ai-context.service.ts → product_training).
 *
 * One row per product or per intake (site, tag). Twelve are seeded (one per
 * currently-routed intake combo); operator can create more for products that
 * aren't tied to any inbound form.
 *
 * The trained_summary text is what the AI actually reads — a digest produced
 * by generateSummary() that consolidates the chat transcript, FAQs, behavior
 * rules, cross-sell hints, and knowledge entries into a single Markdown blob.
 */
export interface Faq {
  q: string;
  a: string;
}

export interface Behavior {
  pricing?: string;
  demo?: string;
  followup?: string;
  handoff?: string;
}

/**
 * Per-tag test-inbound configuration. Keyed by bare tag (no site prefix —
 * site comes from the parent profile's source_site). Used by the training
 * workbench's "Test Inbound" feature to send a simulated form submission
 * through the live AI pipeline and deliver the AI's reply to the operator's
 * own inbox before flipping production auto-reply on.
 */
export interface TestConfig {
  /** Recipient address for test sends. Operator's own inbox, usually. */
  email: string;
  /** Optional override for the `contact.contactName` field on the test
   *  payload. Defaults to "Operator (Test)" if blank. */
  contactName?: string;
  /** ISO timestamp of the most recent test send for this (profile, tag). */
  lastSentAt?: string;
}
export type TestConfigsMap = Record<string, TestConfig>;

export const SALES_TRAINING_STATUSES = ['needs_setup', 'in_progress', 'trained'] as const;
export type SalesTrainingStatus = (typeof SALES_TRAINING_STATUSES)[number];

export const salesTrainingProfiles = pgTable(
  'sales_training_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),

    // Source binding — null on custom products. The (workspace_id, source_site,
    // source_tag) unique constraint enforces "at most one intake-bound profile
    // per (site, tag) per workspace" while allowing N custom profiles (both
    // null treated as distinct by Postgres unique semantics).
    sourceSite: text('source_site'),
    sourceTag: text('source_tag'),

    faqs: jsonb('faqs').$type<Faq[]>().notNull().default([]),
    behavior: jsonb('behavior').$type<Behavior>().notNull().default({}),
    crossSell: jsonb('cross_sell').$type<string[]>().notNull().default([]),

    status: text('status').$type<SalesTrainingStatus>().notNull().default('needs_setup'),
    trainedSummary: text('trained_summary'),
    trainedAt: timestamp('trained_at', { withTimezone: true }),

    seedProtected: boolean('seed_protected').notNull().default(false),
    // Operator-controlled kill switch. When true: AI runtime ignores this
    // profile (getForRuntime returns null) and post-intake-runner creates a
    // human_handoff task instead of review_ai_draft. Used to mark forms the
    // operator wants to handle by hand without deleting the seeded profile.
    disabled: boolean('disabled').notNull().default(false),
    // Per-tag test-inbound configuration. Keyed by bare intake tag →
    // { email, contactName?, lastSentAt? }. Powers the "Test Inbound"
    // pre-launch verification flow in the training workbench.
    testConfigs: jsonb('test_configs').$type<TestConfigsMap>().notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceSlug: uniqueIndex('sales_training_profiles_workspace_slug_unique').on(
      t.workspaceId,
      t.slug,
    ),
    workspaceSource: uniqueIndex('sales_training_profiles_workspace_source_unique').on(
      t.workspaceId,
      t.sourceSite,
      t.sourceTag,
    ),
    workspaceIdx: index('sales_training_profiles_workspace_idx').on(t.workspaceId),
  }),
);

export type SalesTrainingProfile = typeof salesTrainingProfiles.$inferSelect;
export type NewSalesTrainingProfile = typeof salesTrainingProfiles.$inferInsert;

export const SALES_TRAINING_MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;
export type SalesTrainingMessageRole = (typeof SALES_TRAINING_MESSAGE_ROLES)[number];

export const salesTrainingMessages = pgTable(
  'sales_training_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => salesTrainingProfiles.id, { onDelete: 'cascade' }),
    role: text('role').$type<SalesTrainingMessageRole>().notNull(),
    content: text('content').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    profileIdx: index('sales_training_messages_profile_idx').on(t.profileId, t.createdAt),
  }),
);

export type SalesTrainingMessage = typeof salesTrainingMessages.$inferSelect;
export type NewSalesTrainingMessage = typeof salesTrainingMessages.$inferInsert;

/**
 * Knowledge entries. v1 supports typed/pasted content only (source_type =
 * 'typed'). Schema is forward-compatible with file uploads (source_type =
 * 'file', plus a future source_url column).
 *
 * Hard caps at the DB layer:
 *   - title: 1-120 chars
 *   - content: ≤ 20,000 chars
 */
export const KNOWLEDGE_SOURCE_TYPES = ['typed', 'file'] as const;
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

export const KNOWLEDGE_CONTENT_MAX = 20_000;
export const KNOWLEDGE_TITLE_MAX = 120;

export const salesTrainingKnowledge = pgTable(
  'sales_training_knowledge',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => salesTrainingProfiles.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    content: text('content').notNull(),
    sourceType: text('source_type').$type<KnowledgeSourceType>().notNull().default('typed'),
    ordinal: integer('ordinal').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    profileIdx: index('sales_training_knowledge_profile_idx').on(
      t.profileId,
      t.ordinal,
      t.createdAt,
    ),
    contentLen: check(
      'sales_training_knowledge_content_len',
      sql`char_length(${t.content}) <= 20000`,
    ),
    titleLen: check(
      'sales_training_knowledge_title_len',
      sql`char_length(${t.title}) BETWEEN 1 AND 120`,
    ),
  }),
);

export type SalesTrainingKnowledge = typeof salesTrainingKnowledge.$inferSelect;
export type NewSalesTrainingKnowledge = typeof salesTrainingKnowledge.$inferInsert;
