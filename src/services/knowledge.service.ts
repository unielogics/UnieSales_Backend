import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import {
  campaignKnowledgeFiles,
  type CampaignKnowledgeFile,
  type NewCampaignKnowledgeFile,
  DOCUMENT_TYPES,
  type DocumentType,
} from '../db/schema/campaign-knowledge-files';
import { knowledgeKey, putObject, s3UriFor, deleteObject } from './s3.service';
import { NotFoundError, ValidationError } from '../utils/errors';

export async function list(workspaceId: string, campaignId: string): Promise<CampaignKnowledgeFile[]> {
  const db = getDb();
  return db
    .select()
    .from(campaignKnowledgeFiles)
    .where(and(eq(campaignKnowledgeFiles.workspaceId, workspaceId), eq(campaignKnowledgeFiles.campaignId, campaignId)));
}

export async function getById(
  workspaceId: string,
  campaignId: string,
  fileId: string,
): Promise<CampaignKnowledgeFile> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaignKnowledgeFiles)
    .where(
      and(
        eq(campaignKnowledgeFiles.workspaceId, workspaceId),
        eq(campaignKnowledgeFiles.campaignId, campaignId),
        eq(campaignKnowledgeFiles.id, fileId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new NotFoundError('Knowledge file not found');
  return rows[0];
}

export function validateDocumentType(t: unknown): DocumentType | undefined {
  if (t == null) return undefined;
  if (typeof t !== 'string' || !(DOCUMENT_TYPES as readonly string[]).includes(t)) {
    throw new ValidationError('Invalid documentType', [
      { field: 'documentType', reason: `must be one of ${DOCUMENT_TYPES.join(', ')}` },
    ]);
  }
  return t as DocumentType;
}

export interface UploadInput {
  fileName: string;
  buffer: Buffer;
  contentType?: string;
  documentType?: DocumentType;
}

export async function uploadFile(
  workspaceId: string,
  campaignId: string,
  input: UploadInput,
): Promise<CampaignKnowledgeFile> {
  const key = knowledgeKey(workspaceId, campaignId, input.fileName);
  await putObject({
    key,
    body: input.buffer,
    contentType: input.contentType,
    metadata: { workspace_id: workspaceId, campaign_id: campaignId },
  });

  const db = getDb();
  const rows = await db
    .insert(campaignKnowledgeFiles)
    .values({
      workspaceId,
      campaignId,
      fileName: input.fileName,
      fileType: input.contentType ?? null,
      s3Url: s3UriFor(key),
      documentType: input.documentType ?? null,
      extractionStatus: 'pending',
    } as NewCampaignKnowledgeFile)
    .returning();
  return rows[0]!;
}

export async function pasteNotes(
  workspaceId: string,
  campaignId: string,
  input: { fileName: string; content: string; documentType?: DocumentType },
): Promise<CampaignKnowledgeFile> {
  const db = getDb();
  const rows = await db
    .insert(campaignKnowledgeFiles)
    .values({
      workspaceId,
      campaignId,
      fileName: input.fileName,
      fileType: 'text/plain',
      s3Url: null,
      extractedText: input.content,
      documentType: input.documentType ?? 'uploaded_notes',
      extractionStatus: 'extracted', // text already in hand; summary still pending
    } as NewCampaignKnowledgeFile)
    .returning();
  return rows[0]!;
}

export async function updateMeta(
  workspaceId: string,
  campaignId: string,
  fileId: string,
  patch: { documentType?: DocumentType; isActive?: boolean; summary?: string },
): Promise<CampaignKnowledgeFile> {
  await getById(workspaceId, campaignId, fileId);
  const db = getDb();
  const rows = await db
    .update(campaignKnowledgeFiles)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(campaignKnowledgeFiles.id, fileId))
    .returning();
  return rows[0]!;
}

export async function remove(workspaceId: string, campaignId: string, fileId: string): Promise<void> {
  const file = await getById(workspaceId, campaignId, fileId);
  if (file.s3Url) {
    const key = file.s3Url.replace(/^s3:\/\/[^/]+\//, '');
    await deleteObject(key).catch(() => undefined);
  }
  const db = getDb();
  await db.delete(campaignKnowledgeFiles).where(eq(campaignKnowledgeFiles.id, fileId));
}

/** Mark a knowledge file as needing extraction (worker will pick it up). */
export async function requeueExtraction(
  workspaceId: string,
  campaignId: string,
  fileId: string,
): Promise<CampaignKnowledgeFile> {
  await getById(workspaceId, campaignId, fileId);
  const db = getDb();
  const rows = await db
    .update(campaignKnowledgeFiles)
    .set({ extractionStatus: 'pending', updatedAt: new Date() })
    .where(eq(campaignKnowledgeFiles.id, fileId))
    .returning();
  return rows[0]!;
}

/**
 * Worker entry point: lock the next pending knowledge file using SKIP LOCKED
 * and return it. Returns null when nothing's pending.
 */
export async function claimNextPending(): Promise<CampaignKnowledgeFile | null> {
  const db = getDb();
  // Two-step: SELECT FOR UPDATE SKIP LOCKED then UPDATE to mark processing,
  // wrapped in a transaction so other workers don't grab the same row.
  return db.transaction(async (tx) => {
    const candidates = await tx.execute(sql`
      SELECT id FROM ${campaignKnowledgeFiles}
       WHERE ${campaignKnowledgeFiles.extractionStatus} = 'pending'
       ORDER BY ${campaignKnowledgeFiles.createdAt}
       FOR UPDATE SKIP LOCKED
       LIMIT 1
    `);
    const id = (candidates.rows[0] as { id: string } | undefined)?.id;
    if (!id) return null;
    const updated = await tx
      .update(campaignKnowledgeFiles)
      .set({ extractionStatus: 'processing', updatedAt: new Date() })
      .where(eq(campaignKnowledgeFiles.id, id))
      .returning();
    return updated[0] ?? null;
  });
}

export async function markExtracted(
  fileId: string,
  patch: { extractedText: string; documentType?: DocumentType | null; summary?: string | null },
): Promise<void> {
  const db = getDb();
  await db
    .update(campaignKnowledgeFiles)
    .set({
      extractedText: patch.extractedText,
      documentType: patch.documentType ?? null,
      summary: patch.summary ?? null,
      extractionStatus: 'extracted',
      updatedAt: new Date(),
    })
    .where(eq(campaignKnowledgeFiles.id, fileId));
}

export async function markExtractionFailed(fileId: string, reason: string): Promise<void> {
  const db = getDb();
  await db
    .update(campaignKnowledgeFiles)
    .set({ extractionStatus: 'failed', summary: reason.slice(0, 1000), updatedAt: new Date() })
    .where(eq(campaignKnowledgeFiles.id, fileId));
}
