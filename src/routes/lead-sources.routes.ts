import type { FastifyInstance } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as ls from '../services/lead-source.service';

const PathSchema = z.object({ workspaceId: z.string().uuid(), campaignId: z.string().uuid() });
const SourcePathSchema = PathSchema.extend({ sourceId: z.string().uuid() });

const GoogleSheetSchema = z.object({
  sourceName: z.string().max(200).optional(),
  googleSheetId: z.string().min(1),
  googleSheetTab: z.string().optional(),
  fieldMapping: z.record(z.string(), z.string()).optional(),
});
const ManualSchema = z.object({ sourceName: z.string().max(200).optional() });
const MapColumnsSchema = z.object({ fieldMapping: z.record(z.string(), z.string()) });

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

export async function registerLeadSourceRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId/campaigns/:campaignId/lead-sources';

  app.get(base, { preHandler: READ }, async (req) => {
    const { campaignId } = parsePath(PathSchema, req.params);
    return ok({ sources: await ls.list(req.workspace!.id, campaignId) });
  });

  app.post(`${base}/google-sheet`, { preHandler: WRITE }, async (req, reply) => {
    const { campaignId } = parsePath(PathSchema, req.params);
    const input = parseBody(GoogleSheetSchema, req.body);
    const fieldMapping = input.fieldMapping ? ls.validateFieldMapping(input.fieldMapping) : undefined;
    const source = await ls.createGoogleSheet(req.workspace!.id, campaignId, { ...input, fieldMapping });
    reply.code(201);
    return ok({ source }, 'Google Sheet source created');
  });

  app.post(`${base}/csv`, { preHandler: WRITE }, async (req, reply) => {
    const { campaignId } = parsePath(PathSchema, req.params);
    const part: MultipartFile | undefined = await req.file();
    if (!part) throw new ValidationError('No file uploaded', [{ field: 'file', reason: 'multipart file required' }]);
    const buffer = await part.toBuffer();
    const sourceName = (part.fields as Record<string, { value?: string } | undefined>)?.sourceName?.value;
    const fieldMappingRaw = (part.fields as Record<string, { value?: string } | undefined>)?.fieldMapping?.value;
    const fieldMapping = fieldMappingRaw ? ls.validateFieldMapping(JSON.parse(fieldMappingRaw)) : undefined;
    const source = await ls.createCsv(req.workspace!.id, campaignId, {
      fileName: part.filename,
      buffer,
      contentType: part.mimetype,
      sourceName,
      fieldMapping,
    });
    reply.code(201);
    return ok({ source }, 'CSV source uploaded');
  });

  app.post(`${base}/manual`, { preHandler: WRITE }, async (req, reply) => {
    const { campaignId } = parsePath(PathSchema, req.params);
    const input = parseBody(ManualSchema, req.body);
    const source = await ls.createManual(req.workspace!.id, campaignId, input);
    reply.code(201);
    return ok({ source }, 'Manual source created');
  });

  app.post(`${base}/:sourceId/map-columns`, { preHandler: WRITE }, async (req) => {
    const { campaignId, sourceId } = parsePath(SourcePathSchema, req.params);
    const input = parseBody(MapColumnsSchema, req.body);
    const mapping = ls.validateFieldMapping(input.fieldMapping);
    return ok(
      { source: await ls.mapColumns(req.workspace!.id, campaignId, sourceId, mapping) },
      'Column mapping saved',
    );
  });

  app.get(`${base}/:sourceId/preview`, { preHandler: READ }, async (req) => {
    const { campaignId, sourceId } = parsePath(SourcePathSchema, req.params);
    return ok(await ls.preview(req.workspace!.id, campaignId, sourceId));
  });

  app.post(`${base}/:sourceId/import`, { preHandler: WRITE }, async (req) => {
    const { campaignId, sourceId } = parsePath(SourcePathSchema, req.params);
    return ok(await ls.importNow(req.workspace!.id, campaignId, sourceId), 'Import complete');
  });

  app.delete(`${base}/:sourceId`, { preHandler: WRITE }, async (req) => {
    const { campaignId, sourceId } = parsePath(SourcePathSchema, req.params);
    const removed = await ls.remove(req.workspace!.id, campaignId, sourceId);
    return ok({ removed }, removed ? 'Lead source deleted' : 'Not found');
  });
}
