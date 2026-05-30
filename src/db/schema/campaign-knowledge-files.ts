import { pgTable, uuid, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';

// document_type values per spec:
//   product_overview, faq, pricing, pitch_deck, objection_library,
//   compliance, case_study, demo_notes, uploaded_notes, other
export const campaignKnowledgeFiles = pgTable(
  'campaign_knowledge_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),

    fileName: text('file_name').notNull(),
    fileType: text('file_type'),
    s3Url: text('s3_url'),

    extractedText: text('extracted_text'),
    summary: text('summary'),

    documentType: text('document_type'),
    extractionStatus: text('extraction_status').notNull().default('pending'),

    // When true, the AI may attach this file to outbound emails (marketing
    // PDFs, app one-pagers, etc). The AI decides per email whether it's relevant.
    attachToEmails: boolean('attach_to_emails').notNull().default(false),

    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('campaign_knowledge_files_workspace_idx').on(t.workspaceId),
    campaignIdx: index('campaign_knowledge_files_campaign_idx').on(t.campaignId),
    extractionStatusIdx: index('campaign_knowledge_files_extraction_status_idx').on(t.extractionStatus),
  }),
);

export type CampaignKnowledgeFile = typeof campaignKnowledgeFiles.$inferSelect;
export type NewCampaignKnowledgeFile = typeof campaignKnowledgeFiles.$inferInsert;

export const DOCUMENT_TYPES = [
  'product_overview',
  'faq',
  'pricing',
  'pitch_deck',
  'objection_library',
  'compliance',
  'case_study',
  'demo_notes',
  'uploaded_notes',
  'other',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
