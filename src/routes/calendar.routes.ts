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

const PendingQuery = z.object({
  includeSnoozed: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const AttendeeSchema = z.object({
  email: z.string().email(),
  name: z.string().max(200).optional(),
  responseStatus: z.string().max(40).optional(),
});

const LeadSnapshotSchema = z.object({
  contactName: z.string().max(200).nullable().optional(),
  firstName: z.string().max(200).nullable().optional(),
  lastName: z.string().max(200).nullable().optional(),
  companyName: z.string().max(200).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  segment: z.string().max(120).nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  linkedinUrl: z.string().max(500).nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  state: z.string().max(120).nullable().optional(),
  streetAddress: z.string().max(300).nullable().optional(),
  addressFull: z.string().max(500).nullable().optional(),
  source: z.string().max(120).nullable().optional(),
  sourceUrl: z.string().max(500).nullable().optional(),
  sourceNotes: z.string().max(8000).nullable().optional(),
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
    leadSnapshot: LeadSnapshotSchema.nullable().optional(),
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

const OutcomeSchema = z.object({
  outcome: z.enum(['success', 'failure']),
  notes: z.string().max(20000),
  reason: z.enum(['no_show', 'bad_fit', 'budget', 'timing', 'competitor']).nullable().optional(),
  nextAction: z.enum([
    'schedule_follow_up',
    'send_proposal',
    'move_to_contracting',
    'close_won',
    'attempt_reschedule',
    'nurture',
  ]).nullable().optional(),
  followUp: z.object({
    title: z.string().min(1).max(300).optional(),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
  }).nullable().optional(),
}).refine((v) => !v.followUp || v.followUp.endAt > v.followUp.startAt, {
  message: 'followUp.endAt must be after followUp.startAt',
  path: ['followUp', 'endAt'],
});

const SnoozeSchema = z.object({
  untilAt: z.coerce.date(),
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

  app.get(`${base}/post-call-pending`, { preHandler: READ }, async (req) => {
    const q = parse(PendingQuery, req.query, 'Invalid query');
    const result = await calendarService.listPendingOutcomes(req.workspace!.id, req.user!.id, req.workspace!.role, q);
    return ok(result);
  });

  app.post(`${base}/:eventId/outcome`, { preHandler: READ }, async (req) => {
    const { eventId } = parse(EventPath, req.params, 'Invalid path');
    const input = parse(OutcomeSchema, req.body, 'Validation failed');
    const result = await calendarService.logOutcome(req.workspace!.id, eventId, req.user!.id, req.workspace!.role, input);
    return ok(result, 'Meeting outcome logged');
  });

  app.post(`${base}/:eventId/outcome-snooze`, { preHandler: READ }, async (req) => {
    const { eventId } = parse(EventPath, req.params, 'Invalid path');
    const input = parse(SnoozeSchema, req.body, 'Validation failed');
    const result = await calendarService.snoozeOutcome(
      req.workspace!.id,
      eventId,
      req.user!.id,
      req.workspace!.role,
      input.untilAt,
    );
    return ok(result, 'Outcome prompt snoozed');
  });

  app.post(`${base}/:eventId/outcome-ignore`, { preHandler: READ }, async (req) => {
    const { eventId } = parse(EventPath, req.params, 'Invalid path');
    const result = await calendarService.ignoreOutcome(req.workspace!.id, eventId, req.user!.id, req.workspace!.role);
    return ok(result, 'Post-call prompt ignored');
  });

  app.post(`${base}/:eventId/end-now`, { preHandler: READ }, async (req) => {
    const { eventId } = parse(EventPath, req.params, 'Invalid path');
    const result = await calendarService.endMeetingNow(req.workspace!.id, eventId, req.user!.id, req.workspace!.role);
    return ok(result, 'Meeting ended');
  });

  app.post(`${base}/:eventId/sync-meet-artifacts`, { preHandler: READ }, async (req) => {
    const { eventId } = parse(EventPath, req.params, 'Invalid path');
    const result = await calendarService.syncMeetArtifacts(req.workspace!.id, eventId, {
      userId: req.user!.id,
      role: req.workspace!.role,
    });
    return ok(result, 'Google Meet artifacts synced');
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
