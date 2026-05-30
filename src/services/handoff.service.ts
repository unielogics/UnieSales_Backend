/**
 * Handoff service. A handoff is a first-class record (table `handoffs`) that
 * carries a due date, operator notes, an assignee, and a resolution history.
 *
 * Lead linkage: creating a handoff flips the linked lead to
 * status='handoff_required' (aiOwner off); resolving it flips the lead back —
 * 'continue' resumes the AI, 'closed' closes the lead. This keeps the lead and
 * the handoff record in lockstep so nothing is left dangling.
 */
import { and, desc, eq, ne, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { handoffs, type Handoff, type HandoffStatus, HANDOFF_STATUSES } from '../db/schema/handoffs';
import { leads, type Lead } from '../db/schema/leads';
import { NotFoundError, ValidationError } from '../utils/errors';

/**
 * Sales/Campaigns isolation discriminator. Driven by leads.import_origin:
 *   - 'intake'   → Sales mode (public form leads)
 *   - 'outbound' → Campaigns mode (everything else: manual/upload/update/null)
 */
export type OriginFilter = 'intake' | 'outbound';

export interface HandoffWithLead extends Handoff {
  lead: Pick<Lead, 'id' | 'email' | 'contactName' | 'companyName' | 'status' | 'leadScore' | 'gmailThreadId'> | null;
}

function isStatus(s: unknown): s is HandoffStatus {
  return typeof s === 'string' && (HANDOFF_STATUSES as readonly string[]).includes(s);
}

export async function list(
  workspaceId: string,
  opts: { status?: HandoffStatus; origin?: OriginFilter } = {},
): Promise<HandoffWithLead[]> {
  const db = getDb();
  const conds = [eq(handoffs.workspaceId, workspaceId)];
  if (opts.status) conds.push(eq(handoffs.status, opts.status));
  // Sales/Campaigns isolation. Filters via the joined lead's import_origin.
  // Handoffs without a linked lead (rare — only AI-system-internal) are
  // treated as outbound (the legacy default).
  if (opts.origin === 'intake') {
    conds.push(eq(leads.importOrigin, 'intake'));
  } else if (opts.origin === 'outbound') {
    conds.push(or(isNull(leads.importOrigin), ne(leads.importOrigin, 'intake'))!);
  }

  const rows = await db
    .select({
      handoff: handoffs,
      lead: {
        id: leads.id,
        email: leads.email,
        contactName: leads.contactName,
        companyName: leads.companyName,
        status: leads.status,
        leadScore: leads.leadScore,
        gmailThreadId: leads.gmailThreadId,
      },
    })
    .from(handoffs)
    .leftJoin(leads, eq(handoffs.leadId, leads.id))
    .where(and(...conds))
    .orderBy(desc(handoffs.updatedAt))
    .limit(500);

  return rows.map((r) => ({ ...r.handoff, lead: r.lead?.id ? r.lead : null }));
}

export async function getById(workspaceId: string, handoffId: string): Promise<Handoff> {
  const db = getDb();
  const rows = await db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.workspaceId, workspaceId), eq(handoffs.id, handoffId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError('Handoff not found');
  return rows[0];
}

/** The single open handoff for a lead, if any. */
async function findOpenForLead(workspaceId: string, leadId: string): Promise<Handoff | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(handoffs)
    .where(
      and(
        eq(handoffs.workspaceId, workspaceId),
        eq(handoffs.leadId, leadId),
        eq(handoffs.status, 'open'),
      ),
    )
    .orderBy(desc(handoffs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export interface CreateHandoffInput {
  leadId: string;
  campaignId?: string | null;
  emailThreadId?: string | null;
  reason?: string;
  notes?: string;
  dueDate?: Date | null;
  assignee?: string | null;
}

/**
 * Create a handoff (idempotent — if the lead already has an open handoff, the
 * existing one is updated instead of duplicated). Also flips the linked lead
 * to handoff_required.
 */
export async function create(workspaceId: string, input: CreateHandoffInput): Promise<Handoff> {
  const db = getDb();

  // Lead must exist in this workspace.
  const leadRows = await db
    .select()
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, input.leadId)))
    .limit(1);
  const lead = leadRows[0];
  if (!lead) throw new NotFoundError('Lead not found');

  const existing = await findOpenForLead(workspaceId, input.leadId);
  let handoff: Handoff;
  if (existing) {
    const rows = await db
      .update(handoffs)
      .set({
        reason: input.reason ?? existing.reason,
        notes: input.notes ?? existing.notes,
        dueDate: input.dueDate ?? existing.dueDate,
        assignee: input.assignee ?? existing.assignee,
        campaignId: input.campaignId ?? existing.campaignId,
        emailThreadId: input.emailThreadId ?? existing.emailThreadId,
        updatedAt: new Date(),
      })
      .where(eq(handoffs.id, existing.id))
      .returning();
    handoff = rows[0]!;
  } else {
    const rows = await db
      .insert(handoffs)
      .values({
        workspaceId,
        leadId: input.leadId,
        campaignId: input.campaignId ?? lead.campaignId ?? null,
        emailThreadId: input.emailThreadId ?? null,
        status: 'open',
        reason: input.reason ?? null,
        notes: input.notes ?? null,
        dueDate: input.dueDate ?? null,
        assignee: input.assignee ?? null,
      })
      .returning();
    handoff = rows[0]!;
  }

  // Keep the lead in lockstep.
  await db
    .update(leads)
    .set({ status: 'handoff_required', aiOwner: false, updatedAt: new Date() })
    .where(eq(leads.id, input.leadId));

  return handoff;
}

export interface UpdateHandoffInput {
  status?: HandoffStatus;
  reason?: string | null;
  notes?: string | null;
  dueDate?: Date | null;
  assignee?: string | null;
}

export async function update(
  workspaceId: string,
  handoffId: string,
  patch: UpdateHandoffInput,
): Promise<Handoff> {
  if (patch.status && !isStatus(patch.status)) {
    throw new ValidationError('Invalid status', [{ field: 'status', reason: 'invalid value' }]);
  }
  await getById(workspaceId, handoffId);
  const db = getDb();
  const rows = await db
    .update(handoffs)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(handoffs.workspaceId, workspaceId), eq(handoffs.id, handoffId)))
    .returning();
  return rows[0]!;
}

/**
 * Resolve a handoff. resolution 'continue' resumes the AI on the lead;
 * 'closed' closes the lead. Any other string is treated as a continue-style
 * note (lead resumes) with that text recorded.
 */
export async function resolve(
  workspaceId: string,
  handoffId: string,
  resolution: 'continue' | 'closed' | string = 'continue',
): Promise<Handoff> {
  const db = getDb();
  const handoff = await getById(workspaceId, handoffId);

  const now = new Date();
  const rows = await db
    .update(handoffs)
    .set({
      status: resolution === 'dismissed' ? 'dismissed' : 'resolved',
      resolution,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(eq(handoffs.id, handoff.id))
    .returning();

  // Flip the linked lead back.
  const leadPatch =
    resolution === 'closed'
      ? {
          status: 'closed_manual' as const,
          lifecycleStatus: 'closed' as const,
          closedAt: now,
          closeReason: 'handoff_resolved_closed',
          aiOwner: false,
          updatedAt: now,
        }
      : {
          status: 'replied' as const,
          lifecycleStatus: 'active' as const,
          aiOwner: true,
          updatedAt: now,
        };
  await db.update(leads).set(leadPatch).where(eq(leads.id, handoff.leadId));

  return rows[0]!;
}
