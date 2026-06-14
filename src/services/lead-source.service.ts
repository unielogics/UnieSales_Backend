import { and, eq } from 'drizzle-orm';
import { parse as parseCsvSync } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { getDb } from '../config/db';
import {
  campaignLeadSources,
  type CampaignLeadSource,
  type NewCampaignLeadSource,
  LEAD_SOURCE_TYPES,
  type LeadSourceType,
} from '../db/schema/campaign-lead-sources';
import { leads } from '../db/schema/leads';
import { suppressionList } from '../db/schema/suppression-list';
import { knowledgeKey, putObject, getObjectBuffer, s3UriFor } from './s3.service';
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors';
import { recordCostEvent } from './cost.service';

// ---- Field mapping ----

const SYSTEM_FIELDS = [
  'company_name',
  'contact_name',
  'email',
  'title',
  'website',
  'phone',
  'linkedin_url',
  'city',
  'state',
  'street_address',
  'address_full',
  'segment',
  'source',
  'source_notes',
  'personalization',
  'pain_angle',
] as const;
export type SystemField = (typeof SYSTEM_FIELDS)[number];

// Custom-field mapping values use the `custom:<slug>` form so they coexist
// with the fixed SystemField strings inside the same `field_mapping` JSONB.
// The slug becomes the key inside `leads.custom_fields` and the label the AI
// sees in its context, so it must be safe for prompts and JSON.
export type CustomFieldKey = `custom:${string}`;
export type MappedField = SystemField | CustomFieldKey;
const CUSTOM_SLUG_RE = /^[a-z][a-z0-9_]{0,49}$/;

export interface FieldMapping {
  // sourceColumn → mappedField. Columns absent from this map are ignored.
  // mappedField is either a SystemField or `custom:<slug>`.
  [sourceColumn: string]: MappedField;
}

function isSystemField(s: string): s is SystemField {
  return (SYSTEM_FIELDS as readonly string[]).includes(s);
}

function parseCustomKey(s: string): string | null {
  if (!s.startsWith('custom:')) return null;
  const slug = s.slice('custom:'.length);
  return CUSTOM_SLUG_RE.test(slug) ? slug : null;
}

export function validateFieldMapping(raw: unknown): FieldMapping {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('fieldMapping must be an object', [{ field: 'fieldMapping', reason: 'expected object' }]);
  }
  const out: FieldMapping = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new ValidationError(`fieldMapping[${k}] invalid`, [
        { field: `fieldMapping.${k}`, reason: 'value must be a string' },
      ]);
    }
    if (isSystemField(v)) {
      out[k] = v;
    } else if (parseCustomKey(v)) {
      out[k] = v as CustomFieldKey;
    } else {
      throw new ValidationError(`fieldMapping[${k}] invalid`, [
        {
          field: `fieldMapping.${k}`,
          reason: `value must be one of [${SYSTEM_FIELDS.join(', ')}] or "custom:<slug>" (lowercase a-z, 0-9, _; must start with a letter; max 50 chars)`,
        },
      ]);
    }
  }
  // At least one of email / phone must be mapped — phone-only leads import
  // as channel='sms' with a synthetic placeholder email for dedup.
  const vals = Object.values(out);
  if (!vals.includes('email') && !vals.includes('phone')) {
    throw new ValidationError(
      'fieldMapping must map at least one column to "email" or "phone"',
      [{ field: 'fieldMapping', reason: 'no column mapped to email or phone' }],
    );
  }
  return out;
}

// ---- Tabular file parsing ----

/**
 * Detect whether an uploaded buffer is an xlsx (Office Open XML) file. xlsx
 * is a ZIP archive, so the first four bytes are the ZIP local-file signature
 * `PK\x03\x04`. We check magic bytes rather than file extension because
 * operators sometimes rename `.xlsx` files to `.csv` (or vice versa) and the
 * content is the real source of truth.
 */
function looksLikeXlsx(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 && // P
    buffer[1] === 0x4b && // K
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

/**
 * Parse a tabular upload (CSV or XLSX) into a `Record<string,string>[]`.
 * Both formats are normalized into the same shape so the import + preview
 * pipelines downstream stay format-agnostic.
 *
 * - CSV: first non-empty row is the header (csv-parse `columns: true`).
 * - XLSX: first worksheet; first row is the header. Numbers/dates are
 *   serialized to strings so the rest of the pipeline (trim, lowercase, etc.)
 *   keeps working uniformly.
 */
export function parseTabularBuffer(buffer: Buffer, fileName: string): Record<string, string>[] {
  const isXlsx = looksLikeXlsx(buffer) || /\.xlsx?$/i.test(fileName);
  if (isXlsx) {
    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    } catch (err) {
      throw new ValidationError(
        `Could not parse spreadsheet "${fileName}"`,
        [{ field: 'file', reason: err instanceof Error ? err.message : 'unreadable xlsx' }],
      );
    }
    const sheetName = wb.SheetNames[0];
    if (!sheetName) {
      throw new ValidationError(`Spreadsheet "${fileName}" has no sheets`, [
        { field: 'file', reason: 'no sheets' },
      ]);
    }
    const sheet = wb.Sheets[sheetName]!;
    // `defval: ''` means missing cells become empty strings (matching CSV
    // behavior). `raw: false` returns formatted text — dates as ISO strings,
    // numbers as their display string.
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
      raw: false,
    });
    return json.map((row) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = v == null ? '' : String(v);
      }
      return out;
    });
  }
  // CSV (default fallback — handles .csv, unknown extensions, BOM-prefixed UTF-8)
  return parseCsvSync(buffer.toString('utf-8'), {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    bom: true,
  }) as Record<string, string>[];
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

/**
 * Persist an uploaded tabular file (CSV or XLSX) as a `csv_upload` lead
 * source. The `sourceType` stays `csv_upload` for both formats — the parser
 * downstream auto-detects the actual format from magic bytes and filename,
 * so we don't need a separate enum value. (If we ever need to distinguish
 * formats for billing / metrics, we can introduce a separate type later.)
 */
export async function createCsv(
  workspaceId: string,
  campaignId: string,
  input: { fileName: string; buffer: Buffer; contentType?: string; sourceName?: string; fieldMapping?: FieldMapping },
): Promise<CampaignLeadSource> {
  // Best-effort content-type. If the client didn't supply one (the common
  // case from our frontend), infer from the file extension so the bytes
  // round-trip cleanly through S3.
  const inferredCt =
    input.contentType ??
    (/\.xlsx$/i.test(input.fileName)
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : /\.xls$/i.test(input.fileName)
        ? 'application/vnd.ms-excel'
        : 'text/csv');
  // Store the raw file under the same prefix scheme as knowledge files for tenant isolation.
  const key = knowledgeKey(workspaceId, campaignId, `lead-source-${Date.now()}-${input.fileName}`);
  await putObject({
    key,
    body: input.buffer,
    contentType: inferredCt,
    metadata: { workspace_id: workspaceId, campaign_id: campaignId, kind: 'lead_source_csv' },
  });
  const source = await insertSource(workspaceId, campaignId, {
    sourceType: 'csv_upload',
    sourceName: input.sourceName ?? input.fileName,
    uploadedFileUrl: s3UriFor(key),
    fieldMapping: input.fieldMapping ?? null,
  });
  await Promise.all([
    recordCostEvent({
      workspaceId,
      campaignId,
      sourceObjectType: 'campaign_lead_source',
      sourceObjectId: source.id,
      dedupeKey: `lead_source:${source.id}:put_object`,
      provider: 'aws',
      service: 's3',
      category: 'storage',
      actionType: 'put_object',
      quantity: 1,
      unit: 'request',
      costSource: 'estimated',
      metadata: { fileName: input.fileName, bytes: input.buffer.length, key },
    }),
    recordCostEvent({
      workspaceId,
      campaignId,
      sourceObjectType: 'campaign_lead_source',
      sourceObjectId: source.id,
      dedupeKey: `lead_source:${source.id}:storage_gb_month_estimate`,
      provider: 'aws',
      service: 's3',
      category: 'storage',
      actionType: 'storage_gb_month_estimate',
      quantity: input.buffer.length / 1024 / 1024 / 1024,
      unit: 'gb_month',
      costSource: 'estimated',
      metadata: { fileName: input.fileName, bytes: input.buffer.length, key },
    }),
  ]).catch((err) => console.warn('[cost.leadSource.createCsv] record failed', err));
  return source;
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
    // Filename hints at format when magic bytes are ambiguous (e.g. .csv).
    // Preview/import was originally CSV-only; now it auto-detects xlsx too.
    records = parseTabularBuffer(buf, src.sourceName ?? src.uploadedFileUrl);
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
  /** Rows whose email is on the workspace suppression list (bounce/unsubscribe).
   *  Skipped to keep previously-burned addresses out of new outreach. */
  skipped_suppressed: number;
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
    rows = parseTabularBuffer(buf, src.sourceName ?? src.uploadedFileUrl);
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

  // First import of a source = 'upload'; any later run = 'update' (refresh).
  const origin: 'upload' | 'update' = src.lastImportedAt ? 'update' : 'upload';
  return importRows(workspaceId, campaignId, src.id, rows, mapping, origin);
}

async function importRows(
  workspaceId: string,
  campaignId: string,
  sourceId: string,
  rows: Record<string, string>[],
  mapping: FieldMapping,
  origin: 'upload' | 'update' = 'upload',
): Promise<ImportResult> {
  const db = getDb();
  await db
    .update(campaignLeadSources)
    .set({ importStatus: 'importing', updatedAt: new Date() })
    .where(eq(campaignLeadSources.id, sourceId));

  let created = 0;
  let skippedExisting = 0;
  let skippedInvalid = 0;
  let skippedSuppressed = 0;

  // Workspace suppression list — bounces, unsubscribes, SMS STOPs. Imported
  // rows matching these addresses are never created, so we don't email a
  // burned address just because they showed up again in a new file.
  const suppRows = await db
    .select({ email: suppressionList.email })
    .from(suppressionList)
    .where(eq(suppressionList.workspaceId, workspaceId));
  const suppressed = new Set(suppRows.map((r) => r.email.toLowerCase()));

  // Workspace-wide dedup. The DB's unique index catches duplicates within the
  // same campaign; this set also blocks importing a lead that already lives
  // in a SIBLING campaign — so re-uploading a CSV never resurrects a
  // previously-contacted address for new outreach.
  const existingRows = await db
    .select({ email: leads.email })
    .from(leads)
    .where(eq(leads.workspaceId, workspaceId));
  const existingEmails = new Set(existingRows.map((r) => r.email.toLowerCase()));

  for (const row of rows) {
    // Multiple CSV columns can map to the same system field (e.g. "Notes" +
    // "Why Fit" both → source_notes). Concatenate with " · " in that case so
    // no operator-curated context gets dropped.
    const mapped: Partial<Record<SystemField, string>> = {};
    // Operator-defined custom fields: slug → value. Multiple CSV columns
    // could map to the same custom slug, in which case we concatenate the
    // values with " · " (same policy as free-text system fields).
    const customMapped: Record<string, string> = {};
    for (const [col, val] of Object.entries(row)) {
      const target = mapping[col];
      if (!target || val == null) continue;
      const trimmed = String(val).trim();
      if (trimmed === '') continue;
      if (isSystemField(target)) {
        const sys = target;
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
      } else {
        // custom:<slug>
        const slug = parseCustomKey(target);
        if (!slug) continue; // defence-in-depth — validator should have caught this
        const existing = customMapped[slug];
        customMapped[slug] = existing ? `${existing} · ${trimmed}` : trimmed;
      }
    }
    // Channel decision: email if a real address is mapped; otherwise SMS if
    // a phone exists. Phone-only leads get a synthetic placeholder email so
    // the unique (workspace, email, campaign) dedup keeps working.
    const rawEmail = mapped.email?.toLowerCase();
    const hasEmail = !!rawEmail && isLikelyEmail(rawEmail);
    const phoneDigits = String(mapped.phone ?? '').replace(/\D/g, '');
    const phoneLast10 = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : '';
    let email: string;
    let channel: 'email' | 'sms';
    if (hasEmail) {
      email = rawEmail!;
      channel = 'email';
    } else if (phoneLast10) {
      email = `sms+${phoneLast10}@uniesales.local`;
      channel = 'sms';
    } else {
      skippedInvalid++;
      continue;
    }
    // Hard guard: never re-import a previously-burned address (bounce / opt-out).
    if (suppressed.has(email)) {
      skippedSuppressed++;
      continue;
    }
    // Workspace-wide dedup — already a lead somewhere in this workspace.
    if (existingEmails.has(email)) {
      skippedExisting++;
      continue;
    }
    try {
      await db.insert(leads).values({
        workspaceId,
        campaignId,
        email,
        channel,
        companyName: mapped.company_name ?? null,
        contactName: mapped.contact_name ?? null,
        title: mapped.title ?? null,
        website: mapped.website ?? null,
        phone: mapped.phone ?? null,
        linkedinUrl: mapped.linkedin_url ?? null,
        city: mapped.city ?? null,
        state: mapped.state ?? null,
        streetAddress: mapped.street_address ?? null,
        addressFull: mapped.address_full ?? null,
        segment: mapped.segment ?? null,
        source: mapped.source ?? 'import',
        sourceNotes: mapped.source_notes ?? null,
        personalization: mapped.personalization ?? null,
        painAngle: mapped.pain_angle ?? null,
        customFields: Object.keys(customMapped).length > 0 ? customMapped : null,
        status: 'pending_review',
        importOrigin: origin,
      });
      created++;
    } catch (err) {
      // Partial unique index on (workspace_id, LOWER(email), campaign_id) catches dupes.
      // Postgres error code 23505 = unique_violation.
      if ((err as { code?: string }).code === '23505') skippedExisting++;
      else skippedInvalid++;
    }
  }

  const result: ImportResult = {
    created,
    skipped_existing: skippedExisting,
    skipped_invalid: skippedInvalid,
    skipped_suppressed: skippedSuppressed,
    total_rows: rows.length,
  };

  await db
    .update(campaignLeadSources)
    .set({
      importStatus: 'completed',
      lastImportedAt: new Date(),
      lastImportResult: result,
      updatedAt: new Date(),
    })
    .where(eq(campaignLeadSources.id, sourceId));

  return result;
}

function isLikelyEmail(s: string): boolean {
  // Cheap RFC-ish check; the spec'd unique index will catch true duplicates.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ---- Frequency + scheduled sync ----

export const IMPORT_FREQUENCIES = ['manual', 'hourly', 'every_6h', 'daily'] as const;
export type ImportFrequency = (typeof IMPORT_FREQUENCIES)[number];

const FREQUENCY_MS: Record<string, number> = {
  hourly: 60 * 60_000,
  every_6h: 6 * 60 * 60_000,
  daily: 24 * 60 * 60_000,
};

/** Update a source's import frequency / active flag. */
export async function update(
  workspaceId: string,
  campaignId: string,
  sourceId: string,
  patch: { importFrequency?: ImportFrequency; isActive?: boolean },
): Promise<CampaignLeadSource> {
  await getById(workspaceId, campaignId, sourceId);
  if (patch.importFrequency && !(IMPORT_FREQUENCIES as readonly string[]).includes(patch.importFrequency)) {
    throw new ValidationError('Invalid import frequency', [
      { field: 'importFrequency', reason: `one of ${IMPORT_FREQUENCIES.join(', ')}` },
    ]);
  }
  const db = getDb();
  const rows = await db
    .update(campaignLeadSources)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(campaignLeadSources.id, sourceId))
    .returning();
  return rows[0]!;
}

export interface SyncAllResult {
  imported: number;
  failed: number;
}

/**
 * Lead-source sync pass (run by the lead-source worker):
 *  - Any mapped source still at importStatus='pending' → auto-import it
 *    (a freshly connected sheet/CSV starts working without a manual click).
 *  - Any google_sheet on a non-manual frequency whose lastImportedAt is older
 *    than its interval → re-import to pull in newly added rows.
 * importNow dedupes, so re-imports only create genuinely new leads.
 */
export async function importAllDue(): Promise<SyncAllResult> {
  const db = getDb();
  const sources = await db
    .select()
    .from(campaignLeadSources)
    .where(eq(campaignLeadSources.isActive, true));

  const now = Date.now();
  let imported = 0;
  let failed = 0;

  for (const src of sources) {
    if (!src.fieldMapping) continue; // not column-mapped yet — skip
    const isNewPending = src.importStatus === 'pending';

    let isRefreshDue = false;
    if (src.sourceType === 'google_sheet' && src.importFrequency !== 'manual') {
      const interval = FREQUENCY_MS[src.importFrequency];
      if (interval) {
        const last = src.lastImportedAt ? src.lastImportedAt.getTime() : 0;
        isRefreshDue = now - last >= interval;
      }
    }
    if (!isNewPending && !isRefreshDue) continue;

    try {
      await importNow(src.workspaceId, src.campaignId, src.id);
      imported++;
    } catch {
      failed++;
      await db
        .update(campaignLeadSources)
        .set({ importStatus: 'failed', updatedAt: new Date() })
        .where(eq(campaignLeadSources.id, src.id));
    }
  }
  return { imported, failed };
}

export { LEAD_SOURCE_TYPES };
