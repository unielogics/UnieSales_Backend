import { and, asc, desc, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../config/db';
import { leads, LEAD_STATUSES, type Lead, type LeadStatus, type NewLead } from '../db/schema/leads';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import * as suppressionService from './suppression.service';

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
  return conds.length === 1 ? conds[0] : and(...conds);
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
  aiOwner?: boolean;
}

export async function update(workspaceId: string, leadId: string, patch: UpdateLeadInput): Promise<Lead> {
  if (patch.status && !isStatus(patch.status)) {
    throw new ValidationError('Invalid status', [{ field: 'status', reason: 'invalid value' }]);
  }
  await getById(workspaceId, leadId);
  const db = getDb();
  const rows = await db
    .update(leads)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)))
    .returning();
  return rows[0]!;
}

export async function remove(workspaceId: string, leadId: string): Promise<void> {
  await getById(workspaceId, leadId);
  const db = getDb();
  await db.delete(leads).where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)));
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
      updatedAt: new Date(),
    })
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)))
    .returning();
  return rows[0]!;
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
