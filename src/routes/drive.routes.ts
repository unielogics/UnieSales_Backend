import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as driveService from '../services/drive.service';

const PathSchema = z.object({ workspaceId: z.string().uuid() });
const SheetPathSchema = z.object({
  workspaceId: z.string().uuid(),
  spreadsheetId: z.string().min(1).max(200),
});
const ListQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});

function parse<T extends z.ZodTypeAny>(s: T, input: unknown): z.infer<T> {
  const r = s.safeParse(input);
  if (!r.success) {
    throw new ValidationError(
      'Validation failed',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

const READ = [requireAuth, requireWorkspaceMembership];

export async function registerDriveRoutes(app: FastifyInstance): Promise<void> {
  // List user's spreadsheets (via Drive API, using connected Google account's token)
  app.get(
    '/api/workspaces/:workspaceId/drive/spreadsheets',
    { preHandler: READ },
    async (req) => {
      parse(PathSchema, req.params);
      const q = parse(ListQuery, req.query);
      return ok(await driveService.listSpreadsheets(req.workspace!.id, q));
    },
  );

  // List tabs inside a chosen spreadsheet
  app.get(
    '/api/workspaces/:workspaceId/drive/spreadsheets/:spreadsheetId/tabs',
    { preHandler: READ },
    async (req) => {
      const { spreadsheetId } = parse(SheetPathSchema, req.params);
      const tabs = await driveService.listSheetTabs(req.workspace!.id, spreadsheetId);
      return ok({ tabs });
    },
  );
}
