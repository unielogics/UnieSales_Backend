import { pgTable, uuid, text, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { campaigns } from './campaigns';

// source_type per spec: google_sheet, csv_upload, manual
export const campaignLeadSources = pgTable(
  'campaign_lead_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),

    sourceType: text('source_type').notNull(),
    sourceName: text('source_name'),

    googleSheetId: text('google_sheet_id'),
    googleSheetTab: text('google_sheet_tab'),
    uploadedFileUrl: text('uploaded_file_url'),

    fieldMapping: jsonb('field_mapping'),

    importFrequency: text('import_frequency').notNull().default('manual'),
    lastImportedAt: timestamp('last_imported_at', { withTimezone: false }),
    importStatus: text('import_status').notNull().default('pending'),

    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('campaign_lead_sources_workspace_idx').on(t.workspaceId),
    campaignIdx: index('campaign_lead_sources_campaign_idx').on(t.campaignId),
  }),
);

export type CampaignLeadSource = typeof campaignLeadSources.$inferSelect;
export type NewCampaignLeadSource = typeof campaignLeadSources.$inferInsert;

export const LEAD_SOURCE_TYPES = ['google_sheet', 'csv_upload', 'manual'] as const;
export type LeadSourceType = (typeof LEAD_SOURCE_TYPES)[number];
