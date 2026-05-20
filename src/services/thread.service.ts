import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb } from '../config/db';
import { emailThreads, type EmailThread } from '../db/schema/email-threads';
import { emailMessages, type EmailMessage } from '../db/schema/email-messages';
import { leads, type Lead } from '../db/schema/leads';
import { NotFoundError } from '../utils/errors';

export interface ThreadWithMessages extends EmailThread {
  messages: EmailMessage[];
  lead: Pick<Lead, 'id' | 'email' | 'contactName' | 'companyName' | 'status'> | null;
}

export async function list(workspaceId: string, opts: { campaignId?: string; limit?: number; offset?: number }) {
  const db = getDb();
  const conds = [eq(emailThreads.workspaceId, workspaceId)];
  if (opts.campaignId) conds.push(eq(emailThreads.campaignId, opts.campaignId));
  const limit = Math.min(opts.limit ?? 50, 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const items = await db
    .select()
    .from(emailThreads)
    .where(and(...conds))
    .orderBy(desc(emailThreads.updatedAt))
    .limit(limit)
    .offset(offset);
  return { items, limit, offset };
}

export async function getById(workspaceId: string, threadId: string): Promise<ThreadWithMessages> {
  const db = getDb();
  const tRows = await db
    .select()
    .from(emailThreads)
    .where(and(eq(emailThreads.workspaceId, workspaceId), eq(emailThreads.id, threadId)))
    .limit(1);
  const t = tRows[0];
  if (!t) throw new NotFoundError('Thread not found');

  const msgs = await db
    .select()
    .from(emailMessages)
    .where(and(eq(emailMessages.workspaceId, workspaceId), eq(emailMessages.emailThreadId, t.id)))
    .orderBy(asc(emailMessages.createdAt));

  let lead: ThreadWithMessages['lead'] = null;
  if (t.leadId) {
    const lRows = await db
      .select({
        id: leads.id,
        email: leads.email,
        contactName: leads.contactName,
        companyName: leads.companyName,
        status: leads.status,
      })
      .from(leads)
      .where(eq(leads.id, t.leadId))
      .limit(1);
    lead = lRows[0] ?? null;
  }
  return { ...t, messages: msgs, lead };
}

export async function handoff(workspaceId: string, threadId: string): Promise<EmailThread> {
  const db = getDb();
  const t = await getById(workspaceId, threadId);
  await db
    .update(emailThreads)
    .set({ aiOwner: false, status: 'handoff', updatedAt: new Date() })
    .where(eq(emailThreads.id, t.id));
  if (t.leadId) {
    await db
      .update(leads)
      .set({ status: 'handoff_required', aiOwner: false, updatedAt: new Date() })
      .where(eq(leads.id, t.leadId));
  }
  const rows = await db.select().from(emailThreads).where(eq(emailThreads.id, t.id)).limit(1);
  return rows[0]!;
}

export async function stopSequence(workspaceId: string, threadId: string, reason = 'manual_stop'): Promise<EmailThread> {
  const db = getDb();
  const t = await getById(workspaceId, threadId);
  await db
    .update(emailThreads)
    .set({ status: 'stopped', aiOwner: false, updatedAt: new Date() })
    .where(eq(emailThreads.id, t.id));
  if (t.leadId) {
    await db
      .update(leads)
      .set({
        status: 'closed_manual',
        lifecycleStatus: 'closed',
        closeReason: reason,
        closedAt: new Date(),
        nextActionAt: null,
        aiOwner: false,
        updatedAt: new Date(),
      })
      .where(eq(leads.id, t.leadId));
  }
  const rows = await db.select().from(emailThreads).where(eq(emailThreads.id, t.id)).limit(1);
  return rows[0]!;
}

// ---- Handoff queue (leads with status=handoff_required) ----

export async function listHandoffs(workspaceId: string) {
  const db = getDb();
  return db
    .select()
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.status, 'handoff_required')))
    .orderBy(desc(leads.updatedAt))
    .limit(500);
}

export async function createHandoff(workspaceId: string, leadId: string, summary?: string): Promise<Lead> {
  const db = getDb();
  const rows = await db
    .update(leads)
    .set({
      status: 'handoff_required',
      aiOwner: false,
      personalization: summary ?? undefined,
      updatedAt: new Date(),
    })
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)))
    .returning();
  if (!rows[0]) throw new NotFoundError('Lead not found');
  return rows[0];
}

export async function resolveHandoff(workspaceId: string, leadId: string, resolution: 'continue' | 'closed' = 'continue'): Promise<Lead> {
  const db = getDb();
  const patch =
    resolution === 'closed'
      ? { status: 'closed_manual' as const, lifecycleStatus: 'closed' as const, closedAt: new Date(), closeReason: 'handoff_resolved_closed' }
      : { status: 'replied' as const, lifecycleStatus: 'active' as const };
  const rows = await db
    .update(leads)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)))
    .returning();
  if (!rows[0]) throw new NotFoundError('Lead not found');
  return rows[0];
}
