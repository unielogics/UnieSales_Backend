import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as calendarService from '../services/calendar.service';

const ListQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sync: z.coerce.boolean().optional(),
});

const EventPath = z.object({
  workspaceId: z.string().uuid(),
  eventId: z.string().uuid(),
});

const AttendeeSchema = z.object({
  email: z.string().email(),
  name: z.string().max(200).optional(),
  responseStatus: z.string().max(40).optional(),
});

const CreateSchema = z
  .object({
    gmailAccountId: z.string().uuid().optional(),
    title: z.string().min(1).max(300),
    description: z.string().max(8000).optional(),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    attendees: z.array(AttendeeSchema).max(50).optional(),
    leadId: z.string().uuid().nullable().optional(),
    campaignId: z.string().uuid().nullable().optional(),
    emailThreadId: z.string().uuid().nullable().optional(),
    location: z.string().max(500).optional(),
    withMeet: z.boolean().optional(),
  })
  .refine((v) => v.endAt > v.startAt, { message: 'endAt must be after startAt', path: ['endAt'] });

const UpdateSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(8000).optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
  location: z.string().max(500).optional(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
});

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
const WRITE = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

export async function registerCalendarRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId/calendar/events';

  // List events. Pulls fresh from Google Calendar first (best-effort) unless
  // ?sync=false is passed.
  app.get(base, { preHandler: READ }, async (req) => {
    const q = parse(ListQuery, req.query, 'Invalid query');
    const from = q.from ?? new Date(Date.now() - 7 * 86_400_000);
    const to = q.to ?? new Date(Date.now() + 60 * 86_400_000);

    let syncedFromGoogle = 0;
    if (q.sync !== false) {
      try {
        const r = await calendarService.syncWorkspace(req.workspace!.id);
        syncedFromGoogle = r.synced;
      } catch {
        // Google sync failed — still return whatever we have stored.
      }
    }
    const events = await calendarService.listEvents(req.workspace!.id, { from, to });
    return ok({ events, syncedFromGoogle });
  });

  app.post(base, { preHandler: WRITE }, async (req, reply) => {
    const input = parse(CreateSchema, req.body, 'Validation failed');
    const event = await calendarService.createEvent(req.workspace!.id, input);
    reply.code(201);
    return ok({ event }, 'Event created');
  });

  app.patch(`${base}/:eventId`, { preHandler: WRITE }, async (req) => {
    const { eventId } = parse(EventPath, req.params, 'Invalid path');
    const patch = parse(UpdateSchema, req.body, 'Validation failed');
    const event = await calendarService.updateEvent(req.workspace!.id, eventId, patch);
    return ok({ event }, 'Event updated');
  });

  app.delete(`${base}/:eventId`, { preHandler: WRITE }, async (req) => {
    const { eventId } = parse(EventPath, req.params, 'Invalid path');
    const event = await calendarService.cancelEvent(req.workspace!.id, eventId);
    return ok({ event }, 'Event cancelled');
  });

  // Bulk-cancel calendar events. Backs the right-click + Ctrl+multi UI in
  // CalendarView / SalesBookingsView.
  app.post(`${base}/bulk-cancel`, { preHandler: WRITE }, async (req) => {
    const body = parse(
      z.object({ eventIds: z.array(z.string().uuid()).min(1).max(500) }),
      req.body,
      'Invalid body',
    );
    const r = await calendarService.bulkCancelEvents(req.workspace!.id, body.eventIds);
    return ok(r, `${r.cancelled} events cancelled`);
  });
}
