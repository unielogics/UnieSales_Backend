import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ConflictError, ValidationError } from '../utils/errors';
import * as threadService from '../services/thread.service';
import * as aiTasks from '../services/ai-tasks.service';
import * as calendarService from '../services/calendar.service';
import * as leadService from '../services/lead.service';
import { sendEmail } from '../services/gmail.service';
import { sendSmsToLead } from '../services/sms.service';

const ListQuery = z.object({
  campaignId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  // Sales-vs-Campaigns isolation: filters threads by their linked lead's
  // import_origin. Same semantics as the /leads endpoint.
  origin: z.enum(['intake', 'outbound']).optional(),
});

const ThreadPath = z.object({ workspaceId: z.string().uuid(), threadId: z.string().uuid() });

const SendReplySchema = z.object({
  subject: z.string().min(1).max(998).optional(),
  body: z.string().min(1).max(200_000),
});
const StopSchema = z.object({ reason: z.string().max(500).optional() });
const HandoffSchema = z.object({ reason: z.string().max(4000).optional() });

function parseBody<T extends z.ZodTypeAny>(s: T, b: unknown): z.infer<T> {
  const r = s.safeParse(b);
  if (!r.success) {
    throw new ValidationError(
      'Validation failed',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}
function parsePath<T extends z.ZodTypeAny>(s: T, p: unknown): z.infer<T> {
  const r = s.safeParse(p);
  if (!r.success) {
    throw new ValidationError(
      'Invalid path',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}
function parseQuery<T extends z.ZodTypeAny>(s: T, q: unknown): z.infer<T> {
  const r = s.safeParse(q);
  if (!r.success) {
    throw new ValidationError(
      'Invalid query',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

const READ = [requireAuth, requireWorkspaceMembership];
const WRITE = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

export async function registerThreadRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId/threads';

  app.get(base, { preHandler: READ }, async (req) => {
    const q = parseQuery(ListQuery, req.query);
    const r = await threadService.list(req.workspace!.id, q);
    // Frontend expects `threads`; service returns `items` — map it here.
    return ok({ threads: r.items, limit: r.limit, offset: r.offset });
  });

  app.get(`${base}/:threadId`, { preHandler: READ }, async (req) => {
    const { threadId } = parsePath(ThreadPath, req.params);
    return ok({ thread: await threadService.getById(req.workspace!.id, threadId) });
  });

  app.post(`${base}/:threadId/summarize`, { preHandler: WRITE }, async (req) => {
    const { threadId } = parsePath(ThreadPath, req.params);
    const t = await threadService.getById(req.workspace!.id, threadId);
    const result = await aiTasks.summarizeThread({
      workspaceId: req.workspace!.id,
      campaignId: t.campaignId ?? undefined,
      leadId: t.leadId ?? undefined,
      threadId: t.id,
    });
    return ok({ ai: { actionId: result.action.id, ...result.output } });
  });

  app.post(`${base}/:threadId/draft-reply`, { preHandler: WRITE }, async (req) => {
    const { threadId } = parsePath(ThreadPath, req.params);
    const t = await threadService.getById(req.workspace!.id, threadId);
    if (!t.campaignId || !t.leadId) {
      throw new ConflictError('Thread is missing campaign or lead linkage');
    }
    const calConfig = await calendarService.getCalendarConfig(req.workspace!.id);
    const result = await aiTasks.classifyReply({
      workspaceId: req.workspace!.id,
      campaignId: t.campaignId,
      leadId: t.leadId,
      threadId: t.id,
      schedulingHint: { nowIso: new Date().toISOString(), timezone: calConfig.timezone },
    });

    const out = { ...result.output };
    let meetEvent: Awaited<ReturnType<typeof calendarService.bookMeetingFromReply>>['event'] | null = null;

    // call_scheduled → the lead picked a time: book that exact slot (if valid).
    // meeting_request → the lead wants to meet but hasn't picked: offer real
    // open calendar slots in the draft, don't book yet.
    if (out.classification === 'call_scheduled' && out.proposed_time) {
      const when = new Date(out.proposed_time);
      if (calendarService.isWithinBookableHours(when, calConfig)) {
        try {
          const booked = await calendarService.bookMeetingFromReply({
            workspaceId: req.workspace!.id,
            leadId: t.leadId,
            campaignId: t.campaignId,
            emailThreadId: t.id,
            proposedTime: when,
          });
          meetEvent = booked.event;
          const niceTime = calendarService.formatSlotLabel(when, calConfig.timezone);
          const linkLine = booked.meetLink ? ` Here's the video link: ${booked.meetLink}` : '';
          out.reply_body =
            `${out.reply_body ?? ''}\n\nYou're all set — I've sent a calendar invite for ${niceTime}.${linkLine}`.trim();
          out.should_create_draft = true;
          await leadService.update(req.workspace!.id, t.leadId, { status: 'call_scheduled' });
        } catch {
          // Booking failed — return the classification anyway.
        }
      }
    } else if (out.classification === 'meeting_request') {
      try {
        const { slots } = await calendarService.computeAvailableSlots(req.workspace!.id);
        if (slots.length > 0) {
          const lines = slots.map((s) => `  - ${s.label}`).join('\n');
          out.reply_body =
            `${out.reply_body ?? ''}\n\nHere are a few times that work on my end:\n${lines}\n\n` +
            `Reply with whichever suits you and I'll send over a calendar invite.`;
          out.reply_body = out.reply_body.trim();
          out.should_create_draft = true;
        }
        await leadService.update(req.workspace!.id, t.leadId, { status: 'meeting_requested' });
      } catch {
        // Slot computation failed — return the classification anyway.
      }
    }

    return ok({ ai: { actionId: result.action.id, ...out }, meetEvent });
  });

  app.post(`${base}/:threadId/send-reply`, { preHandler: WRITE }, async (req) => {
    const { threadId } = parsePath(ThreadPath, req.params);
    const input = parseBody(SendReplySchema, req.body);
    const t = await threadService.getById(req.workspace!.id, threadId);
    const lead = t.lead;
    if (!lead) throw new ConflictError('Thread has no lead');

    // Channel-aware dispatch: SMS threads send via Twilio, email threads via
    // Gmail. The composer body is the same either way.
    if (t.channel === 'sms') {
      const r = await sendSmsToLead({
        workspaceId: req.workspace!.id,
        leadId: lead.id,
        body: input.body,
      });
      return ok({ messageId: r.messageId, twilioSid: r.twilioSid }, 'SMS sent');
    }

    if (!t.gmailAccountId) throw new ConflictError('Thread has no gmail account');
    const r = await sendEmail({
      workspaceId: req.workspace!.id,
      gmailAccountId: t.gmailAccountId,
      to: lead.email,
      subject: input.subject ?? (t.subject ? `Re: ${t.subject}` : 'Re:'),
      body: input.body,
      threadId: t.gmailThreadId ?? undefined,
      campaignId: t.campaignId ?? undefined,
      leadId: t.leadId ?? undefined,
    });
    return ok(r, 'Reply sent');
  });

  app.post(`${base}/:threadId/handoff`, { preHandler: WRITE }, async (req) => {
    const { threadId } = parsePath(ThreadPath, req.params);
    const body = parseBody(HandoffSchema, req.body ?? {});
    return ok(
      { thread: await threadService.handoff(req.workspace!.id, threadId, body.reason) },
      'Handed off',
    );
  });

  app.post(`${base}/:threadId/stop-sequence`, { preHandler: WRITE }, async (req) => {
    const { threadId } = parsePath(ThreadPath, req.params);
    const body = parseBody(StopSchema, req.body ?? {});
    return ok(
      { thread: await threadService.stopSequence(req.workspace!.id, threadId, body.reason) },
      'Sequence stopped',
    );
  });

  // Bulk-dismiss threads from the Inbox view. Right-click + Ctrl+multi UI.
  app.post(`${base}/bulk-dismiss`, { preHandler: WRITE }, async (req) => {
    const body = parseBody(
      z.object({ threadIds: z.array(z.string().uuid()).min(1).max(500) }),
      req.body,
    );
    const r = await threadService.bulkDismiss(req.workspace!.id, body.threadIds);
    return ok(r, `${r.dismissed} threads dismissed`);
  });
}
