import { and, eq } from 'drizzle-orm';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { getDb } from '../config/db';
import {
  campaignLeadSources,
  type CampaignLeadSource,
  type NewCampaignLeadSource,
  LEAD_SOURCE_TYPES,
  type LeadSourceType,
} from '../db/schema/campaign-lead-sources';
import { leads } from '../db/schema/leads';
import { knowledgeKey, putObject, getObjectBuffer, s3UriFor } from './s3.service';
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors';

// ---- Field mapping ----

const SYSTEM_FIELDS = [
  'company_name',
  'contact_name',
  'email',
  'title',
  'website',
  'phone',
  'linkedin_url',
  'segment',
  'source',
  'source_notes',
  'personalization',
  'pain_angle',
] as const;
export type SystemField = (typeof SYSTEM_FIELDS)[number];

export interface FieldMapping {
  // sourceColumn → systemField. Columns absent from this map are ignored.
  [sourceColumn: string]: SystemField;
}

function isSystemField(s: string): s is SystemField {
  return (SYSTEM_FIELDS as readonly string[]).includes(s);
}

export function validateFieldMapping(raw: unknown): FieldMapping {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('fieldMapping must be an object', [{ field: 'fieldMapping', reason: 'expected object' }]);
  }
  const out: FieldMapping = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string' || !isSystemField(v)) {
      throw new ValidationError(`fieldMapping[${k}] invalid`, [
        { field: `fieldMapping.${k}`, reason: `value must be one of ${SYSTEM_FIELDS.join(', ')}` },
      ]);
    }
    out[k] = v;
  }
  // email must be mapped or import will fail; surface that now
  if (!Object.values(out).includes('email')) {
    throw new ValidationError('fieldMapping must map at least one column to "email"', [
      { field: 'fieldMapping', reason: 'no column mapped to email' },
    ]);
  }
  return out;
}

// ---- CRUD ----

export async function list(workspaceId: string, campaignId: string): Promise<CampaignLeadSource[]> {
  const db = getDb();
  return db
    .select()
    .from(campaignLeadSources)
    .where(and(eq(campaignLeadSources.workspaceId, workspaceId), eq(campaignLeadSources.campaignId, campaignId)));
}

export async function getById(workspaceId: string, campaignId: string, sourceId: string): Promise<CampaignLeadSource> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaignLeadSources)
    .where(
      and(
        eq(campaignLeadSources.workspaceId, workspaceId),
        eq(campaignLeadSources.campaignId, campaignId),
        eq(campaignLeadSources.id, sourceId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new NotFoundError('Lead source not found');
  return rows[0];
}

export async function createGoogleSheet(
  workspaceId: string,
  campaignId: string,
  input: { sourceName?: string; googleSheetId: string; googleSheetTab?: string; fieldMapping?: FieldMapping },
): Promise<CampaignLeadSource> {
  return insertSource(workspaceId, campaignId, {
    sourceType: 'google_sheet',
    sourceName: input.sourceName ?? `Google Sheet ${input.googleSheetId}`,
    googleSheetId: input.googleSheetId,
    googleSheetTab: input.googleSheetTab ?? null,
    fieldMapping: input.fieldMapping ?? null,
  });
}

export async function createCsv(
  workspaceId: string,
  campaignId: string,
  input: { fileName: string; buffer: Buffer; contentType?: string; sourceName?: string; fieldMapping?: FieldMapping },
): Promise<CampaignLeadSource> {
  // Store the raw CSV under the same prefix scheme as knowledge files for tenant isolation.
  const key = knowledgeKey(workspaceId, campaignId, `lead-source-${Date.now()}-${input.fileName}`);
  await putObject({
    key,
    body: input.buffer,
    contentType: input.contentType ?? 'text/csv',
    metadata: { workspace_id: workspaceId, campaign_id: campaignId, kind: 'lead_source_csv' },
  });
  return insertSource(workspaceId, campaignId, {
    sourceType: 'csv_upload',
    sourceName: input.sourceName ?? input.fileName,
    uploadedFileUrl: s3UriFor(key),
    fieldMapping: input.fieldMapping ?? null,
  });
}

export async function createManual(
  workspaceId: string,
  campaignId: string,
  input: { sourceName?: string },
): Promise<CampaignLeadSource> {
  return insertSource(workspaceId, campaignId, {
    sourceType: 'manual',
    sourceName: input.sourceName ?? 'Manual entry',
  });
}

async function insertSource(
  workspaceId: string,
  campaignId: string,
  patch: Partial<NewCampaignLeadSource> & { sourceType: LeadSourceType },
): Promise<CampaignLeadSource> {
  const db = getDb();
  const rows = await db
    .insert(campaignLeadSources)
    .values({ workspaceId, campaignId, ...patch } as NewCampaignLeadSource)
    .returning();
  return rows[0]!;
}

export async function remove(workspaceId: string, campaignId: string, sourceId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .delete(campaignLeadSources)
    .where(
      and(
        eq(campaignLeadSources.workspaceId, workspaceId),
        eq(campaignLeadSources.campaignId, campaignId),
        eq(campaignLeadSources.id, sourceId),
      ),
    )
    .returning({ id: campaignLeadSources.id });
  return rows.length > 0;
}

export async function mapColumns(
  workspaceId: string,
  campaignId: string,
  sourceId: string,
  mapping: FieldMapping,
): Promise<CampaignLeadSource> {
  await getById(workspaceId, campaignId, sourceId);
  const db = getDb();
  const rows = await db
    .update(campaignLeadSources)
    .set({ fieldMapping: mapping, updatedAt: new Date() })
    .where(eq(campaignLeadSources.id, sourceId))
    .returning();
  return rows[0]!;
}

// ---- Preview / Import ----

export interface PreviewResult {
  columns: string[];
  rows: Record<string, string>[];
  totalRows: number;
}

/** Read the first N rows of the source (for the column-mapping UI). CSV + Google Sheet supported. */
export async function preview(
  workspaceId: string,
  campaignId: string,
  sourceId: string,
  limit = 5,
): Promise<PreviewResult> {
  const src = await getById(workspaceId, campaignId, sourceId);

  let records: Record<string, string>[];
  if (src.sourceType === 'csv_upload') {
    if (!src.uploadedFileUrl) throw new NotFoundError('Uploaded file URL missing');
    const key = src.uploadedFileUrl.replace(/^s3:\/\/[^/]+\//, '');
    const buf = await getObjectBuffer(key);
    records = parseCsvSync(buf.toString('utf-8'), {
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
    }) as Record<string, string>[];
  } else if (src.sourceType === 'google_sheet') {
    if (!src.googleSheetId) throw new NotFoundError('Google Sheet ID missing');
    const { readSheetRows } = await import('./drive.service');
    records = await readSheetRows(workspaceId, src.googleSheetId, src.googleSheetTab ?? 'Sheet1');
  } else {
    throw new ConflictError(`Preview not supported for sourceType ${src.sourceType}`, [
      { field: 'sourceType', reason: 'use csv_upload or google_sheet' },
    ]);
  }

  const first = records[0] ?? {};
  return {
    columns: Object.keys(first),
    rows: records.slice(0, limit),
    totalRows: records.length,
  };
}

export interface ImportResult {
  created: number;
  skipped_existing: number;
  skipped_invalid: number;
  total_rows: number;
}

/** Run the actual import for a source. CSV in v1; google_sheet errors until Phase 8. */
export async function importNow(workspaceId: string, campaignId: string, sourceId: string): Promise<ImportResult> {
  const src = await getById(workspaceId, campaignId, sourceId);
  if (!src.fieldMapping) {
    throw new ConflictError('No column mapping set — call /map-columns first', [
      { field: 'fieldMapping', reason: 'required before import' },
    ]);
  }
  const mapping = validateFieldMapping(src.fieldMapping);

  let rows: Record<string, string>[];
  if (src.sourceType === 'csv_upload') {
    if (!src.uploadedFileUrl) throw new NotFoundError('Uploaded file URL missing');
    const key = src.uploadedFileUrl.replace(/^s3:\/\/[^/]+\//, '');
    const buf = await getObjectBuffer(key);
    rows = parseCsvSync(buf.toString('utf-8'), {
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
    }) as Record<string, string>[];
  } else if (src.sourceType === 'google_sheet') {
    if (!src.googleSheetId) {
      throw new ConflictError('Google Sheet source missing googleSheetId', [
        { field: 'googleSheetId', reason: 'required' },
      ]);
    }
    const { readSheetRows } = await import('./drive.service');
    rows = await readSheetRows(workspaceId, src.googleSheetId, src.googleSheetTab ?? 'Sheet1');
  } else if (src.sourceType === 'manual') {
    throw new ConflictError('Manual sources do not support bulk import', [
      { field: 'sourceType', reason: 'add leads via /api/workspaces/:wid/leads' },
    ]);
  } else {
    throw new ConflictError(`Unknown sourceType ${src.sourceType}`);
  }

  return importRows(workspaceId, campaignId, src.id, rows, mapping);
}

async function importRows(
  workspaceId: string,
  campaignId: string,
  sourceId: string,
  rows: Record<string, string>[],
  mapping: FieldMapping,
): Promise<ImportResult> {
  const db = getDb();
  await db
    .update(campaignLeadSources)
    .set({ importStatus: 'importing', updatedAt: new Date() })
    .where(eq(campaignLeadSources.id, sourceId));

  let created = 0;
  let skippedExisting = 0;
  let skippedInvalid = 0;

  for (const row of rows) {
    // Multiple CSV columns can map to the same system field (e.g. "Notes" +
    // "Why Fit" both → source_notes). Concatenate with " · " in that case so
    // no operator-curated context gets dropped.
    const mapped: Partial<Record<SystemField, string>> = {};
    for (const [col, val] of Object.entries(row)) {
      const sys = mapping[col];
      if (!sys || val == null) continue;
      const trimmed = String(val).trim();
      if (trimmed === '') continue;
      const existing = mapped[sys];
      if (existing) {
        // Free-text fields concatenate; structured fields take the first non-empty value
        if (sys === 'source_notes' || sys === 'personalization' || sys === 'pain_angle') {
          mapped[sys] = `${existing} · ${col}: ${trimmed}`;
        }
        // else: keep first value
      } else {
        mapped[sys] = sys === 'source_notes' || sys === 'personalization' || sys === 'pain_angle'
          ? `${col}: ${trimmed}`
          : trimmed;
      }
    }
    const email = mapped.email?.toLowerCase();
    if (!email || !isLikelyEmail(email)) {
      skippedInvalid++;
      continue;
    }
    try {
      await db.insert(leads).values({
        workspaceId,
        campaignId,
        email,
        companyName: mapped.company_name ?? null,
        contactName: mapped.contact_name ?? null,
        title: mapped.title ?? null,
        website: mapped.website ?? null,
        phone: mapped.phone ?? null,
        linkedinUrl: mapped.linkedin_url ?? null,
        segment: mapped.segment ?? null,
        source: mapped.source ?? 'import',
        sourceNotes: mapped.source_notes ?? null,
        personalization: mapped.personalization ?? null,
        painAngle: mapped.pain_angle ?? null,
        status: 'pending_review',
      });
      created++;
    } catch (err) {
      // Partial unique index on (workspace_id, LOWER(email), campaign_id) catches dupes.
      // Postgres error code 23505 = unique_violation.
      if ((err as { code?: string }).code === '23505') skippedExisting++;
      else skippedInvalid++;
    }
  }

  await db
    .update(campaignLeadSources)
    .set({ importStatus: 'completed', lastImportedAt: new Date(), updatedAt: new Date() })
    .where(eq(campaignLeadSources.id, sourceId));

  return { created, skipped_existing: skippedExisting, skipped_invalid: skippedInvalid, total_rows: rows.length };
}

function isLikelyEmail(s: string): boolean {
  // Cheap RFC-ish check; the spec'd unique index will catch true duplicates.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export { LEAD_SOURCE_TYPES };
