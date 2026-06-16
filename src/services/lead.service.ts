import { and, asc, desc, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../config/db';
import { leads, LEAD_STATUSES, type Lead, type LeadStatus, type NewLead } from '../db/schema/leads';
import { workspaceMembers } from '../db/schema/workspace-members';
import { campaigns } from '../db/schema/campaigns';
import { emailThreads } from '../db/schema/email-threads';
import { emailMessages } from '../db/schema/email-messages';
import { aiActions, type AiAction } from '../db/schema/ai-actions';
import { calendarEvents } from '../db/schema/calendar-events';
import { handoffs } from '../db/schema/handoffs';
import { leadProcessingLocks } from '../db/schema/lead-processing-locks';
import { notifications } from '../db/schema/notifications';
import { salesActivities } from '../db/schema/sales-activities';
import { salesNotes } from '../db/schema/sales-notes';
import { salesTasks } from '../db/schema/sales-tasks';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import * as suppressionService from './suppression.service';
import * as notify from './notification.service';

const INBOUND_WORKSPACE_ID = '00000000-0000-4000-a000-000000000001';

// ---- Filters ----

export interface LeadFilters {
  campaignId?: string;
  status?: LeadStatus | LeadStatus[];
  lifecycleStatus?: 'active' | 'paused' | 'closed';
  q?: string; // search company/contact/email
  limit?: number;
  offset?: number;
  orderBy?: 'created_at' | 'updated_at' | 'last_engagement_at' | 'lead_score';
  orderDir?: 'asc' | 'desc';
  /**
   * Sales-vs-Campaigns mode isolation:
   *  - 'intake'   → only inbound public-form leads (import_origin = 'intake')
   *  - 'outbound' → only campaign-imported leads (import_origin IN ('upload','update') OR NULL)
   *  - undefined  → no origin filter (returns everything)
   * The frontend passes 'intake' from Sales-mode pages and 'outbound' from
   * Campaigns-mode pages so the two worlds never bleed into each other.
   */
  origin?: 'intake' | 'outbound';
}

function isStatus(s: unknown): s is LeadStatus {
  return typeof s === 'string' && (LEAD_STATUSES as readonly string[]).includes(s);
}

function buildWhere(workspaceId: string, f: LeadFilters): SQL | undefined {
  const conds: SQL[] = [eq(leads.workspaceId, workspaceId)];
  if (f.campaignId) conds.push(eq(leads.campaignId, f.campaignId));
  if (f.status) {
    const arr = Array.isArray(f.status) ? f.status : [f.status];
    conds.push(inArray(leads.status, arr));
  }
  if (f.lifecycleStatus) conds.push(eq(leads.lifecycleStatus, f.lifecycleStatus));
  if (f.q && f.q.trim()) {
    const like = `%${f.q.trim()}%`;
    conds.push(
      sql`(${leads.companyName} ILIKE ${like} OR ${leads.contactName} ILIKE ${like} OR ${leads.email} ILIKE ${like})`,
    );
  }
  if (f.origin === 'intake') {
    conds.push(eq(leads.importOrigin, 'intake'));
  } else if (f.origin === 'outbound') {
    // Outbound = anything that didn't come through the public intake API.
    // Includes CSV/Sheet imports ('upload', 'update') AND nulls (manual /
    // pre-Layer-1 legacy leads).
    conds.push(sql`(${leads.importOrigin} IS NULL OR ${leads.importOrigin} <> 'intake')`);
  }
  return conds.length === 1 ? conds[0] : and(...conds);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function roleCanWrite(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

async function assertTargetWriteAccess(tx: any, workspaceId: string, userId: string): Promise<void> {
  const rows = await tx
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  if (!rows[0] || !roleCanWrite(rows[0].role)) {
    throw new ForbiddenError('You do not have write access to the target workspace');
  }
}

async function findTargetLead(
  tx: any,
  workspaceId: string,
  campaignId: string | null,
  email: string,
): Promise<Lead | null> {
  const campaignCond = campaignId ? eq(leads.campaignId, campaignId) : isNull(leads.campaignId);
  const rows = await tx
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, workspaceId),
        campaignCond,
        sql`lower(${leads.email}) = ${email}`,
        isNull(leads.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function appendSourceNote(existing: string | null | undefined, note: string): string {
  const current = (existing ?? '').trim();
  return current ? `${current}\n\n${note}` : note;
}

function transferSourceNote(
  source: Lead,
  sourceWorkspaceId: string,
  targetMode: 'sales' | 'campaign',
  targetWorkspaceId: string,
  targetCampaignId: string | null,
): string {
  const target = targetMode === 'sales' ? 'Sales' : `Campaign ${targetCampaignId}`;
  return [
    `Moved to ${target} on ${new Date().toISOString()}.`,
    `Original lead: ${source.id}.`,
    `Original workspace: ${sourceWorkspaceId}.`,
    source.campaignId ? `Original campaign: ${source.campaignId}.` : null,
    `Target workspace: ${targetWorkspaceId}.`,
  ]
    .filter(Boolean)
    .join(' ');
}

export interface PaginatedLeads {
  items: Lead[];
  total: number;
  limit: number;
  offset: number;
}

export async function list(workspaceId: string, f: LeadFilters): Promise<PaginatedLeads> {
  const db = getDb();
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);
  const where = buildWhere(workspaceId, f);

  const orderColumn = (() => {
    switch (f.orderBy) {
      case 'updated_at':
        return leads.updatedAt;
      case 'last_engagement_at':
        return leads.lastEngagementAt;
      case 'lead_score':
        return leads.leadScore;
      default:
        return leads.createdAt;
    }
  })();
  const orderFn = f.orderDir === 'asc' ? asc : desc;

  const items = await db
    .select()
    .from(leads)
    .where(where)
    .orderBy(orderFn(orderColumn))
    .limit(limit)
    .offset(offset);

  const totalRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(where);

  return { items, total: totalRows[0]?.n ?? 0, limit, offset };
}

export async function getById(workspaceId: string, leadId: string): Promise<Lead> {
  const db = getDb();
  const rows = await db
    .select()
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError('Lead not found');
  return rows[0];
}

export interface CreateLeadInput {
  email: string;
  campaignId?: string;
  companyName?: string;
  contactName?: string;
  title?: string;
  website?: string;
  phone?: string;
  linkedinUrl?: string;
  segment?: string;
  source?: string;
  sourceNotes?: string;
  status?: LeadStatus;
  /**
   * Discriminator for Sales-vs-Campaigns isolation. Manual UI creates leave
   * this undefined → defaults to 'manual' which keeps them out of Sales-mode
   * filters. Intake-API leads come in as 'intake' from intake.service.
   */
  importOrigin?: 'manual' | 'upload' | 'update' | 'intake' | null;
}

export async function create(workspaceId: string, input: CreateLeadInput): Promise<Lead> {
  if (await suppressionService.isSuppressed(workspaceId, input.email)) {
    throw new ConflictError('Email is on the suppression list', [
      { field: 'email', reason: 'suppressed in this workspace' },
    ]);
  }
  if (input.status && !isStatus(input.status)) {
    throw new ValidationError('Invalid status', [{ field: 'status', reason: 'invalid value' }]);
  }
  const db = getDb();
  try {
    const rows = await db
      .insert(leads)
      .values({
        workspaceId,
        email: input.email.trim().toLowerCase(),
        campaignId: input.campaignId ?? null,
        companyName: input.companyName ?? null,
        contactName: input.contactName ?? null,
        title: input.title ?? null,
        website: input.website ?? null,
        phone: input.phone ?? null,
        linkedinUrl: input.linkedinUrl ?? null,
        segment: input.segment ?? null,
        source: input.source ?? 'manual',
        sourceNotes: input.sourceNotes ?? null,
        status: input.status ?? 'new',
        // Manual creation is outbound by definition. The intake API sets this
        // to 'intake' through its own code path. Setting it explicitly keeps
        // manual leads OUT of Sales-mode filters that match on import_origin.
        importOrigin: input.importOrigin ?? 'manual',
      } as NewLead)
      .returning();
    return rows[0]!;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new ConflictError('A lead with this email already exists in the campaign', [
        { field: 'email', reason: 'duplicate within campaign' },
      ]);
    }
    throw err;
  }
}

export interface UpdateLeadInput {
  campaignId?: string;
  /** Operator can correct a broken/bad email. Triggers email-send-failure
   *  reset in the update() handler when the value actually changes. */
  email?: string;
  companyName?: string | null;
  contactName?: string | null;
  title?: string | null;
  website?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  segment?: string | null;
  status?: LeadStatus;
  leadScore?: number;
  leadScoreReason?: string;
  painAngle?: string;
  personalization?: string;
  sourceNotes?: string | null;
  nextActionAt?: Date | null;
  aiOwner?: boolean;
  channel?: 'email' | 'sms';
  /** Sales-mode pipeline stage slug — free-form text per the leads schema. */
  pipelineStage?: string | null;
}

export async function update(workspaceId: string, leadId: string, patch: UpdateLeadInput): Promise<Lead> {
  if (patch.status && !isStatus(patch.status)) {
    throw new ValidationError('Invalid status', [{ field: 'status', reason: 'invalid value' }]);
  }
  const existing = await getById(workspaceId, leadId);
  const db = getDb();
  // If the operator updates lead.email AND the address actually changes,
  // clear the email-send-failure stamp so the AI can attempt to send to the
  // corrected address again. Comparison is case-insensitive + trims to
  // match how the column is stored.
  const extraResets: Partial<typeof leads.$inferInsert> = {};
  if (
    typeof patch.email === 'string' &&
    patch.email.trim().toLowerCase() !==
      (existing.email ?? '').trim().toLowerCase() &&
    existing.emailSendFailedAt
  ) {
    extraResets.emailSendFailedAt = null;
    extraResets.emailSendFailReason = null;
  }
  const rows = await db
    .update(leads)
    .set({ ...patch, ...extraResets, updatedAt: new Date() })
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)))
    .returning();
  return rows[0]!;
}

export async function remove(workspaceId: string, leadId: string): Promise<void> {
  const r = await bulkPermanentDelete(workspaceId, [leadId]);
  if (r.deleted === 0) throw new NotFoundError('Lead not found');
}

export async function bulkPermanentDelete(
  workspaceId: string,
  leadIds: string[],
): Promise<{ deleted: number }> {
  if (leadIds.length === 0) return { deleted: 0 };
  const uniqueIds = Array.from(new Set(leadIds));
  const db = getDb();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: leads.id, email: leads.email })
      .from(leads)
      .where(and(eq(leads.workspaceId, workspaceId), inArray(leads.id, uniqueIds)));
    if (rows.length === 0) return { deleted: 0 };
    const ids = rows.map((r) => r.id);

    await tx
      .delete(salesNotes)
      .where(and(eq(salesNotes.workspaceId, workspaceId), inArray(salesNotes.leadId, ids)));
    await tx
      .delete(salesTasks)
      .where(and(eq(salesTasks.workspaceId, workspaceId), inArray(salesTasks.leadId, ids)));
    await tx
      .delete(salesActivities)
      .where(and(eq(salesActivities.workspaceId, workspaceId), inArray(salesActivities.leadId, ids)));
    await tx
      .delete(handoffs)
      .where(and(eq(handoffs.workspaceId, workspaceId), inArray(handoffs.leadId, ids)));
    await tx
      .delete(leadProcessingLocks)
      .where(and(eq(leadProcessingLocks.workspaceId, workspaceId), inArray(leadProcessingLocks.leadId, ids)));

    await tx
      .update(aiActions)
      .set({ leadId: null })
      .where(and(eq(aiActions.workspaceId, workspaceId), inArray(aiActions.leadId, ids)));
    await tx
      .update(emailMessages)
      .set({ leadId: null })
      .where(and(eq(emailMessages.workspaceId, workspaceId), inArray(emailMessages.leadId, ids)));
    await tx
      .update(emailThreads)
      .set({ leadId: null })
      .where(and(eq(emailThreads.workspaceId, workspaceId), inArray(emailThreads.leadId, ids)));
    await tx
      .update(calendarEvents)
      .set({ leadId: null, updatedAt: new Date() })
      .where(and(eq(calendarEvents.workspaceId, workspaceId), inArray(calendarEvents.leadId, ids)));
    await tx
      .update(notifications)
      .set({ leadId: null })
      .where(and(eq(notifications.workspaceId, workspaceId), inArray(notifications.leadId, ids)));

    const deleted = await tx
      .delete(leads)
      .where(and(eq(leads.workspaceId, workspaceId), inArray(leads.id, ids)))
      .returning({ id: leads.id });
    return { deleted: deleted.length };
  });
}

export interface MoveLeadsInput {
  leadIds: string[];
  targetMode: 'sales' | 'campaign';
  targetWorkspaceId?: string;
  targetCampaignId?: string;
  userId: string;
}

export interface MoveLeadsResult {
  moved: number;
  created: number;
  merged: number;
  archived: number;
  targets: Array<{ sourceLeadId: string; targetLeadId: string; targetWorkspaceId: string; created: boolean }>;
}

export async function moveLeads(workspaceId: string, input: MoveLeadsInput): Promise<MoveLeadsResult> {
  if (input.leadIds.length === 0) return { moved: 0, created: 0, merged: 0, archived: 0, targets: [] };
  const uniqueIds = Array.from(new Set(input.leadIds));
  const targetWorkspaceId = input.targetMode === 'sales' ? INBOUND_WORKSPACE_ID : input.targetWorkspaceId;
  if (!targetWorkspaceId) {
    throw new ValidationError('Target workspace is required', [
      { field: 'targetWorkspaceId', reason: 'required for campaign moves' },
    ]);
  }
  if (input.targetMode === 'campaign' && !input.targetCampaignId) {
    throw new ValidationError('Target campaign is required', [
      { field: 'targetCampaignId', reason: 'required for campaign moves' },
    ]);
  }

  const db = getDb();
  return db.transaction(async (tx) => {
    await assertTargetWriteAccess(tx, targetWorkspaceId, input.userId);
    if (input.targetMode === 'campaign') {
      const targetCampaign = await tx
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(eq(campaigns.workspaceId, targetWorkspaceId), eq(campaigns.id, input.targetCampaignId!)))
        .limit(1);
      if (!targetCampaign[0]) throw new NotFoundError('Target campaign not found');
    }

    const sourceRows = await tx
      .select()
      .from(leads)
      .where(and(eq(leads.workspaceId, workspaceId), inArray(leads.id, uniqueIds), isNull(leads.deletedAt)));
    if (sourceRows.length === 0) return { moved: 0, created: 0, merged: 0, archived: 0, targets: [] };

    const targets: MoveLeadsResult['targets'] = [];
    let created = 0;
    let merged = 0;
    for (const source of sourceRows) {
      const email = normalizeEmail(source.email);
      const targetCampaignId = input.targetMode === 'campaign' ? input.targetCampaignId! : null;
      const existing = await findTargetLead(tx, targetWorkspaceId, targetCampaignId, email);
      const transferNote = transferSourceNote(source, workspaceId, input.targetMode, targetWorkspaceId, targetCampaignId);
      if (existing) {
        const [updated] = await tx
          .update(leads)
          .set({
            companyName: existing.companyName ?? source.companyName,
            contactName: existing.contactName ?? source.contactName,
            firstName: existing.firstName ?? source.firstName,
            lastName: existing.lastName ?? source.lastName,
            title: existing.title ?? source.title,
            phone: existing.phone ?? source.phone,
            website: existing.website ?? source.website,
            linkedinUrl: existing.linkedinUrl ?? source.linkedinUrl,
            segment: existing.segment ?? source.segment,
            sourceNotes: appendSourceNote(existing.sourceNotes, transferNote),
            updatedAt: new Date(),
          })
          .where(and(eq(leads.workspaceId, targetWorkspaceId), eq(leads.id, existing.id)))
          .returning();
        merged += 1;
        targets.push({ sourceLeadId: source.id, targetLeadId: updated!.id, targetWorkspaceId, created: false });
      } else {
        const [inserted] = await tx
          .insert(leads)
          .values({
            workspaceId: targetWorkspaceId,
            campaignId: targetCampaignId,
            email,
            companyName: source.companyName,
            contactName: source.contactName,
            firstName: source.firstName,
            lastName: source.lastName,
            title: source.title,
            website: source.website,
            phone: source.phone,
            linkedinUrl: source.linkedinUrl,
            segment: source.segment,
            source: input.targetMode === 'sales' ? 'campaign_upgrade' : 'sales_demote',
            sourceUrl: source.sourceUrl,
            sourceNotes: appendSourceNote(source.sourceNotes, transferNote),
            status: input.targetMode === 'sales' ? 'interested' : 'new',
            lifecycleStatus: 'active',
            pipelineStage: input.targetMode === 'sales' ? 'new_inbound' : null,
            aiOwner: false,
            importOrigin: input.targetMode === 'sales' ? 'sales_manual' : 'manual',
            customFields: source.customFields,
          } as NewLead)
          .returning();
        created += 1;
        targets.push({ sourceLeadId: source.id, targetLeadId: inserted!.id, targetWorkspaceId, created: true });
      }
    }

    const archivedRows = await tx
      .update(leads)
      .set({
        deletedAt: new Date(),
        aiOwner: false,
        lifecycleStatus: 'closed',
        status: 'closed_manual',
        nextActionAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(leads.workspaceId, workspaceId), inArray(leads.id, sourceRows.map((l) => l.id))))
      .returning({ id: leads.id });

    return {
      moved: targets.length,
      created,
      merged,
      archived: archivedRows.length,
      targets,
    };
  });
}

/**
 * Soft-delete a batch of leads. The rows stay in the database but every UI
 * surface and every AI worker filters `deleted_at IS NULL`, so this is the
 * operator's kill-switch for inbound leads the AI should stop touching.
 * Idempotent — re-running on already-deleted leads no-ops.
 */
export async function bulkSoftDelete(
  workspaceId: string,
  leadIds: string[],
): Promise<{ deleted: number }> {
  if (leadIds.length === 0) return { deleted: 0 };
  const db = getDb();
  const result = await db
    .update(leads)
    .set({
      deletedAt: new Date(),
      // Stopping the AI is the whole point — flip aiOwner off too so any
      // worker that didn't get the deleted_at filter still won't act.
      aiOwner: false,
      lifecycleStatus: 'closed',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(leads.workspaceId, workspaceId),
        inArray(leads.id, leadIds),
        // Only delete rows not already deleted (idempotent).
        sql`${leads.deletedAt} IS NULL`,
      ),
    )
    .returning({ id: leads.id });
  return { deleted: result.length };
}

/**
 * Cancel a batch of scheduled outbound sends. Clears `next_action_at` so
 * the followup worker stops picking these leads up. The lead row is NOT
 * deleted — it stays active, just without a queued send. The operator can
 * re-queue manually via the lead detail UI if they change their mind.
 *
 * This is the "queue delete" affordance: in the Inbox / AI Queue tab, the
 * "Scheduled to send" group is exactly the leads with `next_action_at`
 * set, so clearing that timestamp removes them from the queue view.
 */
export async function bulkCancelScheduled(
  workspaceId: string,
  leadIds: string[],
): Promise<{ cancelled: number }> {
  if (leadIds.length === 0) return { cancelled: 0 };
  const db = getDb();
  const result = await db
    .update(leads)
    .set({
      nextActionAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(leads.workspaceId, workspaceId),
        inArray(leads.id, leadIds),
        sql`${leads.nextActionAt} IS NOT NULL`,
      ),
    )
    .returning({ id: leads.id });
  return { cancelled: result.length };
}

/**
 * Restore previously soft-deleted leads. No UI hook yet, but the function is
 * here so an operator who fat-fingered a bulk delete can recover via curl or
 * a future admin tool.
 */
export async function bulkRestore(
  workspaceId: string,
  leadIds: string[],
): Promise<{ restored: number }> {
  if (leadIds.length === 0) return { restored: 0 };
  const db = getDb();
  const result = await db
    .update(leads)
    .set({
      deletedAt: null,
      aiOwner: true,
      lifecycleStatus: 'active',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(leads.workspaceId, workspaceId),
        inArray(leads.id, leadIds),
        sql`${leads.deletedAt} IS NOT NULL`,
      ),
    )
    .returning({ id: leads.id });
  return { restored: result.length };
}

export interface BulkUpdateInput {
  leadIds: string[];
  patch: UpdateLeadInput;
}

export async function bulkUpdate(workspaceId: string, input: BulkUpdateInput): Promise<{ updated: number }> {
  if (input.leadIds.length === 0) return { updated: 0 };
  if (input.patch.status && !isStatus(input.patch.status)) {
    throw new ValidationError('Invalid status', [{ field: 'status', reason: 'invalid value' }]);
  }
  const db = getDb();
  const result = await db
    .update(leads)
    .set({ ...input.patch, updatedAt: new Date() })
    .where(and(eq(leads.workspaceId, workspaceId), inArray(leads.id, input.leadIds)))
    .returning({ id: leads.id });
  return { updated: result.length };
}

export async function pause(workspaceId: string, leadId: string, until?: Date): Promise<Lead> {
  const db = getDb();
  await getById(workspaceId, leadId);
  const rows = await db
    .update(leads)
    .set({
      status: 'paused',
      lifecycleStatus: 'paused',
      pausedUntil: until ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)))
    .returning();
  return rows[0]!;
}

export async function close(
  workspaceId: string,
  leadId: string,
  closeReason: string,
  closeStatus: LeadStatus = 'closed_manual',
): Promise<Lead> {
  if (!isStatus(closeStatus) || !closeStatus.startsWith('closed_')) {
    throw new ValidationError('Invalid close status', [
      { field: 'status', reason: 'must be a closed_* status' },
    ]);
  }
  await getById(workspaceId, leadId);
  const db = getDb();
  const rows = await db
    .update(leads)
    .set({
      status: closeStatus,
      lifecycleStatus: 'closed',
      closeReason,
      closedAt: new Date(),
      // Closing also cancels any scheduled follow-up — the worker already
      // filters on lifecycle, but this keeps next_action_at honest.
      nextActionAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)))
    .returning();
  const closed = rows[0]!;

  // Notify on explicit win/loss outcomes (mobile Alerts + push). Best-effort.
  const won = closeStatus.includes('won');
  const lost = closeStatus.includes('lost');
  if (won || lost) {
    const who = closed.companyName ?? closed.contactName ?? closed.email;
    await notify.emit({
      workspaceId,
      leadId,
      kind: won ? 'won' : 'lost',
      priority: won ? 'normal' : 'low',
      title: won ? `Won — ${who}` : `Lost — ${who}`,
      body: closeReason || null,
    });
  }
  return closed;
}

/**
 * Suppress the lead's email at workspace level and close the lead.
 */
export async function suppress(workspaceId: string, leadId: string, reason?: string): Promise<{ lead: Lead; leadsClosed: number }> {
  const lead = await getById(workspaceId, leadId);
  const r = await suppressionService.suppressEmailAndCloseLeads(workspaceId, lead.email, reason);
  const refreshed = await getById(workspaceId, leadId);
  return { lead: refreshed, leadsClosed: r.leadsClosed };
}

// ---- Activity timeline ----

export interface LeadActivityEvent {
  at: string;
  kind: 'created' | 'email_out' | 'email_in' | 'ai' | 'meeting' | 'handoff';
  title: string;
  detail: string | null;
}

const AI_ACTION_TITLES: Record<string, string> = {
  score_lead: 'AI scored the lead',
  generate_email: 'AI drafted an email',
  generate_reply: 'AI drafted a reply',
  create_draft: 'AI drafted a reply',
  classify_reply: 'AI classified a reply',
  handoff: 'AI flagged for handoff',
  stop_sequence: 'AI stopped the sequence',
  pause_lead: 'AI paused the lead',
  summarize_thread: 'AI summarised the thread',
};

function aiActionDetail(a: AiAction): string | null {
  if (a.reason) return a.reason;
  const o = (a.aiOutput ?? {}) as Record<string, unknown>;
  if (a.actionType === 'score_lead' && typeof o.score === 'number') return `Score ${o.score}/100`;
  if (a.actionType === 'classify_reply' && typeof o.classification === 'string') {
    return `Classified "${o.classification}"`;
  }
  return null;
}

/** A merged, newest-first activity feed for a lead — every tracked event. */
export async function getActivity(workspaceId: string, leadId: string): Promise<LeadActivityEvent[]> {
  const lead = await getById(workspaceId, leadId); // throws if not found / wrong workspace
  const db = getDb();
  const events: LeadActivityEvent[] = [];

  events.push({
    at: lead.createdAt.toISOString(),
    kind: 'created',
    title: 'Lead created',
    detail: lead.source ? `Source: ${lead.source}` : null,
  });

  const msgs = await db
    .select()
    .from(emailMessages)
    .where(and(eq(emailMessages.workspaceId, workspaceId), eq(emailMessages.leadId, leadId)));
  for (const m of msgs) {
    const out = m.direction === 'outbound' || m.direction === 'draft';
    events.push({
      at: m.createdAt.toISOString(),
      kind: out ? 'email_out' : 'email_in',
      title: m.direction === 'draft' ? 'Draft created' : out ? 'Email sent' : 'Reply received',
      detail: m.subject ?? null,
    });
  }

  const actions = await db
    .select()
    .from(aiActions)
    .where(and(eq(aiActions.workspaceId, workspaceId), eq(aiActions.leadId, leadId)));
  for (const a of actions) {
    events.push({
      at: (a.completedAt ?? a.createdAt).toISOString(),
      kind: 'ai',
      title: AI_ACTION_TITLES[a.actionType ?? ''] ?? 'AI action',
      detail: aiActionDetail(a),
    });
  }

  const evs = await db
    .select()
    .from(calendarEvents)
    .where(and(eq(calendarEvents.workspaceId, workspaceId), eq(calendarEvents.leadId, leadId)));
  for (const e of evs) {
    events.push({
      at: e.createdAt.toISOString(),
      kind: 'meeting',
      title: 'Meeting booked',
      detail: `${e.title} · ${e.startAt.toLocaleString()}`,
    });
  }

  const hos = await db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.workspaceId, workspaceId), eq(handoffs.leadId, leadId)));
  for (const h of hos) {
    events.push({
      at: h.createdAt.toISOString(),
      kind: 'handoff',
      title: 'Handed off to a human',
      detail: h.reason ?? null,
    });
    if (h.resolvedAt) {
      events.push({
        at: h.resolvedAt.toISOString(),
        kind: 'handoff',
        title: 'Handoff resolved',
        detail: h.resolution ?? null,
      });
    }
  }

  events.sort((a, b) => b.at.localeCompare(a.at));
  return events;
}

/** Quick search by email (used by reply intake to find the original lead). */
export async function findByEmail(workspaceId: string, email: string): Promise<Lead | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), ilike(leads.email, email)))
    .limit(1);
  return rows[0] ?? null;
}
