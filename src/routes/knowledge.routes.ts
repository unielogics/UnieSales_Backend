import type { FastifyInstance } from 'fastify';
import multipart, { type MultipartFile } from '@fastify/multipart';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as knowledge from '../services/knowledge.service';
import { presignDownload } from '../services/s3.service';

const PathSchema = z.object({ workspaceId: z.string().uuid(), campaignId: z.string().uuid() });
const FilePathSchema = PathSchema.extend({ fileId: z.string().uuid() });

const PasteSchema = z.object({
  fileName: z.string().min(1).max(200),
  content: z.string().min(1).max(2_000_000),
  documentType: z.string().optional(),
});

const UpdateSchema = z.object({
  documentType: z.string().optional(),
  isActive: z.boolean().optional(),
  summary: z.string().optional(),
});

function parseBody<T extends z.ZodTypeAny>(s: T, body: unknown): z.infer<T> {
  const r = s.safeParse(body);
  if (!r.success) {
    throw new ValidationError(
      'Validation failed',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

function parsePath<T extends z.ZodTypeAny>(s: T, params: unknown): z.infer<T> {
  const r = s.safeParse(params);
  if (!r.success) {
    throw new ValidationError(
      'Invalid path',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

const READ = [requireAuth, requireWorkspaceMembership];
const WRITE = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

export async function registerKnowledgeRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB
      files: 1,
    },
  });

  const base = '/api/workspaces/:workspaceId/campaigns/:campaignId/knowledge';

  app.get(base, { preHandler: READ }, async (req) => {
    const { campaignId } = parsePath(PathSchema, req.params);
    return ok({ files: await knowledge.list(req.workspace!.id, campaignId) });
  });

  app.post(`${base}/upload`, { preHandler: WRITE }, async (req, reply) => {
    const { campaignId } = parsePath(PathSchema, req.params);
    const part: MultipartFile | undefined = await req.file();
    if (!part) throw new ValidationError('No file uploaded', [{ field: 'file', reason: 'multipart file required' }]);
    const buffer = await part.toBuffer();
    const docTypeRaw = (part.fields as Record<string, { value?: string } | undefined>)?.documentType?.value;
    const documentType = knowledge.validateDocumentType(docTypeRaw);
    const result = await knowledge.uploadFile(req.workspace!.id, campaignId, {
      fileName: part.filename,
      buffer,
      contentType: part.mimetype,
      documentType,
    });
    reply.code(201);
    return ok({ file: result }, 'Uploaded — extraction queued');
  });

  app.post(`${base}/paste`, { preHandler: WRITE }, async (req, reply) => {
    const { campaignId } = parsePath(PathSchema, req.params);
    const input = parseBody(PasteSchema, req.body);
    const documentType = knowledge.validateDocumentType(input.documentType);
    const result = await knowledge.pasteNotes(req.workspace!.id, campaignId, {
      fileName: input.fileName,
      content: input.content,
      documentType,
    });
    reply.code(201);
    return ok({ file: result }, 'Stored');
  });

  app.get(`${base}/:fileId`, { preHandler: READ }, async (req) => {
    const { campaignId, fileId } = parsePath(FilePathSchema, req.params);
    const file = await knowledge.getById(req.workspace!.id, campaignId, fileId);
    // Provide a fresh presigned download URL if file is in S3
    let presignedUrl: string | null = null;
    if (file.s3Url) {
      const key = file.s3Url.replace(/^s3:\/\/[^/]+\//, '');
      presignedUrl = await presignDownload(key);
    }
    return ok({ file, presignedUrl });
  });

  app.patch(`${base}/:fileId`, { preHandler: WRITE }, async (req) => {
    const { campaignId, fileId } = parsePath(FilePathSchema, req.params);
    const patch = parseBody(UpdateSchema, req.body);
    const documentType = knowledge.validateDocumentType(patch.documentType);
    return ok(
      {
        file: await knowledge.updateMeta(req.workspace!.id, campaignId, fileId, {
          documentType,
          isActive: patch.isActive,
          summary: patch.summary,
        }),
      },
      'Updated',
    );
  });

  app.delete(`${base}/:fileId`, { preHandler: WRITE }, async (req) => {
    const { campaignId, fileId } = parsePath(FilePathSchema, req.params);
    await knowledge.remove(req.workspace!.id, campaignId, fileId);
    return ok({ deleted: true }, 'Deleted');
  });

  app.post(`${base}/:fileId/extract`, { preHandler: WRITE }, async (req) => {
    const { campaignId, fileId } = parsePath(FilePathSchema, req.params);
    return ok(
      { file: await knowledge.requeueExtraction(req.workspace!.id, campaignId, fileId) },
      'Re-queued for extraction',
    );
  });

  app.post(`${base}/:fileId/summarize`, { preHandler: WRITE }, async () => {
    return ok({ summarized: false }, 'AI summarization wired up in Phase 9');
  });
}
