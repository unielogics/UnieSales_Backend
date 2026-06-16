import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as leadService from '../services/lead.service';
import * as suppressionService from '../services/suppression.service';
import * as threadService from '../services/thread.service';
import * as aiTasks from '../services/ai-tasks.service';
import * as gmailService from '../services/gmail.service';
import * as bookingPageService from '../services/booking-page.service';
import { sendSmsToLead } from '../services/sms.service';
import { ConflictError } from '../utils/errors';
import { LEAD_STATUSES, type LeadStatus } from '../db/schema/leads';

const WorkspacePath = z.object({ workspaceId: z.string().uuid() });
const LeadPath = WorkspacePath.extend({ leadId: z.string().uuid() });

const ListQuery = z.object({
  campaignId: z.string().uuid().optional(),
  status: z.string().optional(), // comma-separated allowed
  lifecycleStatus: z.enum(['active', 'paused', 'closed']).optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  orderBy: z.enum(['created_at', 'updated_at', 'last_engagement_at', 'lead_score']).optional(),
  orderDir: z.enum(['asc', 'desc']).optional(),
  // Sales-vs-Campaigns mode isolation. `intake` = inbound public-form leads
  // only; `outbound` = CSV/Sheet/manual leads only; omitted = everything.
  origin: z.enum(['intake', 'outbound']).optional(),
});

const CreateSchema = z.object({
  email: z.string().email().max(254),
  campaignId: z.string().uuid().optional(),
  companyName: z.string().max(200).optional(),
  contactName: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  website: z.string().max(500).optional(),
  phone: z.string().max(50).optional(),
  linkedinUrl: z.string().max(500).optional(),
  segment: z.string().max(120).optional(),
  source: z.string().max(120).optional(),
  sourceNotes: z.string().optional(),
  status: z.string().optional(),
});

const UpdateSchema = z.object({
  campaignId: z.string().uuid().optional(),
  companyName: z.string().max(200).nullable().optional(),
  contactName: z.string().max(200).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  linkedinUrl: z.string().max(500).nullable().optional(),
  segment: z.string().max(120).nullable().optional(),
  status: z.string().optional(),
  leadScore: z.number().int().min(0).max(100).optional(),
  leadScoreReason: z.string().max(2000).optional(),
  painAngle: z.string().max(2000).optional(),
  personalization: z.string().max(4000).optional(),
  sourceNotes: z.string().max(8000).nullable().optional(),
  aiOwner: z.boolean().optional(),
  // Sales-mode pipeline stage. Free-form string so adding new stages later
  // doesn't require a migration. The frontend Pipeline view consumes a fixed
  // list (new_inbound, ai_reviewed, ai_contacting, replied, booking_link_sent,
  // booked, opportunity, won, lost, nurture_later).
  pipelineStage: z.string().max(50).nullable().optional(),
});

const BulkSchema = z.object({
  leadIds: z.array(z.string().uuid()).min(1).max(500),
  patch: UpdateSchema,
});
const BulkLeadIdsSchema = z.object({
  leadIds: z.array(z.string().uuid()).min(1).max(500),
});
const MoveLeadsSchema = z.object({
  leadIds: z.array(z.string().uuid()).min(1).max(500),
  targetMode: z.enum(['sales', 'campaign']),
  targetWorkspaceId: z.string().uuid().optional(),
  targetCampaignId: z.string().uuid().optional(),
  archiveSource: z.literal(true).optional().default(true),
});

const PauseSchema = z.object({ pausedUntil: z.string().datetime().optional() });
const CloseSchema = z.object({
  closeReason: z.string().min(1).max(500),
  status: z.string().optional(),
});
const SuppressSchema = z.object({ reason: z.string().max(500).optional() });

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

function parseStatusFilter(s?: string): LeadStatus | LeadStatus[] | undefined {
  if (!s) return undefined;
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  for (const p of parts) {
    if (!(LEAD_STATUSES as readonly string[]).includes(p)) {
      throw new ValidationError('Invalid status filter', [{ field: 'status', reason: `'${p}' is not a valid status` }]);
    }
  }
  return parts.length === 1 ? (parts[0] as LeadStatus) : (parts as LeadStatus[]);
}

const READ = [requireAuth, requireWorkspaceMembership];
const WRITE = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

export async function registerLeadRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId/leads';

  app.get(base, { preHandler: READ }, async (req) => {
    const q = parseQuery(ListQuery, req.query);
    const r = await leadService.list(req.workspace!.id, {
      ...q,
      status: parseStatusFilter(q.status),
    });
    // Frontend expects `leads`; service returns `items` — map it here.
    return ok({ leads: r.items, total: r.total, limit: r.limit, offset: r.offset });
  });

  app.post(base, { preHandler: WRITE }, async (req, reply) => {
    const input = parseBody(CreateSchema, req.body);
    const lead = await leadService.create(req.workspace!.id, {
      ...input,
      status: input.status as LeadStatus | undefined,
    });
    reply.code(201);
    return ok({ lead }, 'Lead created');
  });

  app.post(`${base}/bulk-update`, { preHandler: WRITE }, async (req) => {
    const input = parseBody(BulkSchema, req.body);
    const r = await leadService.bulkUpdate(req.workspace!.id, {
      leadIds: input.leadIds,
      patch: { ...input.patch, status: input.patch.status as LeadStatus | undefined },
    });
    return ok(r, `${r.updated} leads updated`);
  });

  // Soft-delete a batch of leads. Sets deleted_at + flips aiOwner off so
  // every UI surface and every worker stops touching them. Idempotent.
  app.post(`${base}/bulk-delete`, { preHandler: WRITE }, async (req) => {
    const input = parseBody(BulkLeadIdsSchema, req.body);
    const r = await leadService.bulkSoftDelete(req.workspace!.id, input.leadIds);
    return ok(r, `${r.deleted} leads deleted`);
  });

  // Permanently delete lead files. Linked operational rows are removed,
  // reporting/history rows are detached, then the lead rows are deleted.
  app.post(`${base}/bulk-permanent-delete`, { preHandler: WRITE }, async (req) => {
    const input = parseBody(BulkLeadIdsSchema, req.body);
    const r = await leadService.bulkPermanentDelete(req.workspace!.id, input.leadIds);
    return ok(r, `${r.deleted} leads permanently deleted`);
  });

  app.post(`${base}/move`, { preHandler: WRITE }, async (req) => {
    const input = parseBody(MoveLeadsSchema, req.body);
    const r = await leadService.moveLeads(req.workspace!.id, {
      leadIds: input.leadIds,
      targetMode: input.targetMode,
      targetWorkspaceId: input.targetWorkspaceId,
      targetCampaignId: input.targetCampaignId,
      userId: req.user!.id,
    });
    return ok(r, `${r.moved} leads moved`);
  });

  // Cancel a batch of scheduled outbound sends. Backs the AI Queue's
  // "Scheduled to send" delete affordance — clears next_action_at so the
  // followup worker stops picking these leads up. Lead survives.
  app.post(`${base}/bulk-cancel-scheduled`, { preHandler: WRITE }, async (req) => {
    const input = parseBody(BulkLeadIdsSchema, req.body);
    const r = await leadService.bulkCancelScheduled(req.workspace!.id, input.leadIds);
    return ok(r, `${r.cancelled} sends cancelled`);
  });

  // Restore previously soft-deleted leads. No UI hook yet; here for recovery
  // via curl if the operator deletes by mistake.
  app.post(`${base}/bulk-restore`, { preHandler: WRITE }, async (req) => {
    const input = parseBody(BulkLeadIdsSchema, req.body);
    const r = await leadService.bulkRestore(req.workspace!.id, input.leadIds);
    return ok(r, `${r.restored} leads restored`);
  });

  app.get(`${base}/:leadId`, { preHandler: READ }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    return ok({ lead: await leadService.getById(req.workspace!.id, leadId) });
  });

  // Email conversation history for the lead modal's Thread tab.
  app.get(`${base}/:leadId/threads`, { preHandler: READ }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const threads = await threadService.listByLead(req.workspace!.id, leadId);
    return ok({ threads });
  });

  // Full activity timeline for the lead modal's Activity tab.
  app.get(`${base}/:leadId/activity`, { preHandler: READ }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const events = await leadService.getActivity(req.workspace!.id, leadId);
    return ok({ events });
  });

  app.patch(`${base}/:leadId`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const patch = parseBody(UpdateSchema, req.body);
    const lead = await leadService.update(req.workspace!.id, leadId, {
      ...patch,
      status: patch.status as LeadStatus | undefined,
    });
    return ok({ lead }, 'Updated');
  });

  app.delete(`${base}/:leadId`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    await leadService.remove(req.workspace!.id, leadId);
    return ok({ deleted: true }, 'Lead deleted');
  });

  app.post(`${base}/:leadId/pause`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const input = parseBody(PauseSchema, req.body ?? {});
    const lead = await leadService.pause(
      req.workspace!.id,
      leadId,
      input.pausedUntil ? new Date(input.pausedUntil) : undefined,
    );
    return ok({ lead }, 'Lead paused');
  });

  app.post(`${base}/:leadId/close`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const input = parseBody(CloseSchema, req.body);
    const lead = await leadService.close(
      req.workspace!.id,
      leadId,
      input.closeReason,
      (input.status ?? 'closed_manual') as LeadStatus,
    );
    return ok({ lead }, 'Lead closed');
  });

  app.post(`${base}/:leadId/suppress`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const input = parseBody(SuppressSchema, req.body ?? {});
    const r = await leadService.suppress(req.workspace!.id, leadId, input.reason);
    return ok(r, 'Lead and email suppressed');
  });

  // ---- AI scoring / email generation ----
  app.post(`${base}/:leadId/score`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const lead = await leadService.getById(req.workspace!.id, leadId);
    if (!lead.campaignId) {
      throw new ConflictError('Lead has no campaign assigned', [
        { field: 'campaignId', reason: 'required for scoring' },
      ]);
    }
    const result = await aiTasks.scoreLead({
      workspaceId: req.workspace!.id,
      campaignId: lead.campaignId,
      leadId,
    });
    const updated = await leadService.update(req.workspace!.id, leadId, {
      leadScore: result.output.score,
      leadScoreReason: result.output.reasoning,
      status: 'scored',
    });
    return ok({ lead: updated, ai: { actionId: result.action.id, ...result.output } }, 'Scored');
  });

  const GenerateEmailSchema = z.object({
    stage: z.enum(['cold', 'followup_1', 'followup_2', 'followup_3', 'breakup']).optional(),
  });
  app.post(`${base}/:leadId/generate-email`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const input = parseBody(GenerateEmailSchema, req.body ?? {});
    const lead = await leadService.getById(req.workspace!.id, leadId);
    if (!lead.campaignId) {
      throw new ConflictError('Lead has no campaign assigned', [
        { field: 'campaignId', reason: 'required for email generation' },
      ]);
    }
    const result = await aiTasks.generateEmail({
      workspaceId: req.workspace!.id,
      campaignId: lead.campaignId,
      leadId,
      stage: input.stage,
    });
    return ok({ ai: { actionId: result.action.id, ...result.output } }, 'Email drafted');
  });

  // Send-next is wired up in Phase 11 (workers); the route stays so the UI knows it exists.
  app.post(`${base}/:leadId/send-next`, { preHandler: WRITE }, async () => {
    return ok({ sent: false }, 'Use /api/workspaces/:wid/gmail/send for now; sequencer lands in Phase 11');
  });

  // Inline composer on the LeadDetail center column. If the lead has an
  // existing email thread, this is identical to /threads/:id/send-reply (uses
  // that thread's gmail account + thread id for Gmail-side stitching).
  // Otherwise we send a fresh email from the workspace's first active gmail
  // account — Gmail creates the thread, we link it to this lead via leadId.
  const SendLeadReplySchema = z.object({
    subject: z.string().max(500).optional(),
    body: z.string().min(1).max(20000),
  });
  app.post(`${base}/:leadId/send-reply`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const input = parseBody(SendLeadReplySchema, req.body);
    const lead = await leadService.getById(req.workspace!.id, leadId);

    // Prefer the lead's most recent thread (any direction). That gives us the
    // gmail account + Gmail thread id so the reply stitches into the existing
    // conversation properly.
    const threads = await threadService.listByLead(req.workspace!.id, leadId);
    const existing = threads[0] ?? null;

    // SMS path stays out of the inline composer for now — operators send SMS
    // from the Inbox where the thread UI is full-screen.
    if (existing && existing.channel === 'sms') {
      const r = await sendSmsToLead({
        workspaceId: req.workspace!.id,
        leadId,
        body: input.body,
      });
      return ok({ kind: 'sms', messageId: r.messageId }, 'SMS sent');
    }

    let gmailAccountId: string | null = existing?.gmailAccountId ?? null;
    if (!gmailAccountId) {
      // Fresh outbound — fall back to the workspace's first active gmail account.
      const accounts = await gmailService.listAccounts(req.workspace!.id);
      const usable = accounts.find((a) => a.isActive && a.healthStatus !== 'paused');
      if (!usable) {
        throw new ConflictError(
          'No active Gmail account on this workspace — connect one in Settings.',
          [{ field: 'gmail', reason: 'no_active_account' }],
        );
      }
      gmailAccountId = usable.id;
    }

    const subjectLine =
      input.subject ??
      (existing?.subject ? `Re: ${existing.subject}` : `Hello ${lead.contactName ?? ''}`.trim());

    const r = await gmailService.sendEmail({
      workspaceId: req.workspace!.id,
      gmailAccountId,
      to: lead.email,
      subject: subjectLine,
      body: input.body,
      threadId: existing?.gmailThreadId ?? undefined,
      campaignId: lead.campaignId ?? undefined,
      leadId,
    });
    return ok({ kind: 'email', ...r }, 'Reply sent');
  });

  // Lead-level bookings (any booking_requests where guest_email == lead.email).
  // Powers the LeadDetail center-column "Calendar" widget so the operator can
  // see what this lead has already booked / pending without leaving the panel.
  app.get(`${base}/:leadId/bookings`, { preHandler: READ }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const lead = await leadService.getById(req.workspace!.id, leadId);
    const items = await bookingPageService.listRequestsByGuestEmail(
      req.workspace!.id,
      lead.email,
    );
    return ok({ items });
  });

  // ---- Workspace-level suppression list ----
  app.get('/api/workspaces/:workspaceId/suppression', { preHandler: READ }, async (req) => {
    return ok({ suppression: await suppressionService.list(req.workspace!.id) });
  });

  app.post('/api/workspaces/:workspaceId/suppression', { preHandler: WRITE }, async (req, reply) => {
    const schema = z.object({
      email: z.string().email().max(254),
      reason: z.string().max(500).optional(),
    });
    const input = parseBody(schema, req.body);
    const r = await suppressionService.suppressEmailAndCloseLeads(req.workspace!.id, input.email, input.reason);
    reply.code(201);
    return ok(r, 'Email suppressed');
  });

  app.delete('/api/workspaces/:workspaceId/suppression/:entryId', { preHandler: WRITE }, async (req) => {
    const schema = z.object({ workspaceId: z.string().uuid(), entryId: z.string().uuid() });
    const r = schema.safeParse(req.params);
    if (!r.success) throw new ValidationError('Invalid path');
    const removed = await suppressionService.removeById(req.workspace!.id, r.data.entryId);
    return ok({ removed }, removed ? 'Removed from suppression list' : 'Not found');
  });
}
