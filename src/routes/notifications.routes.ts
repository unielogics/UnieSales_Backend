import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as notificationService from '../services/notification.service';

const ListQuery = z.object({
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const IdPath = z.object({
  workspaceId: z.string().uuid(),
  id: z.string().uuid(),
});

const ReadBody = z.object({ read: z.literal(true) });

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, label: string): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ValidationError(
      label,
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

const READ = [requireAuth, requireWorkspaceMembership];

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId/notifications';

  app.get(base, { preHandler: READ }, async (req) => {
    const q = parse(ListQuery, req.query, 'Invalid query');
    const items = await notificationService.list(req.workspace!.id, {
      unread: q.unread === 'true',
      userId: req.user!.id,
      limit: q.limit,
      offset: q.offset,
    });
    return ok({ items });
  });

  app.get(`${base}/counts`, { preHandler: READ }, async (req) => {
    const counts = await notificationService.getCounts(req.workspace!.id, req.user!.id);
    return ok(counts);
  });

  app.patch(`${base}/:id`, { preHandler: READ }, async (req) => {
    const { id } = parse(IdPath, req.params, 'Invalid path');
    parse(ReadBody, req.body, 'Validation failed');
    const notification = await notificationService.markRead(req.workspace!.id, id);
    return ok({ notification }, 'Marked read');
  });

  app.post(`${base}/mark-all-read`, { preHandler: READ }, async (req) => {
    const result = await notificationService.markAllRead(req.workspace!.id, req.user!.id);
    return ok(result, 'All marked read');
  });
}
