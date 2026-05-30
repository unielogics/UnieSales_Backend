import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { emailThreads, type EmailThread } from '../db/schema/email-threads';
import { emailMessages, type EmailMessage } from '../db/schema/email-messages';
import { leads, type Lead } from '../db/schema/leads';
import { NotFoundError } from '../utils/errors';
import * as handoffService from './handoff.service';

export interface ThreadWithMessages extends EmailThread {
  messages: EmailMessage[];
  lead: Pick<
    Lead,
    'id' | 'email' | 'contactName' | 'companyName' | 'status' | 'nextActionAt' | 'painAngle' | 'personalization'
  > | null;
}

export async function list(
  workspaceId: string,
  opts: {
    campaignId?: string;
    limit?: number;
    offset?: number;
    /**
     * Sales-vs-Campaigns mode isolation:
     *  - 'intake'   → only threads tied to leads with import_origin='intake'
     *  - 'outbound' → only threads tied to leads with import_origin <> 'intake' (or null)
     *  - undefined  → no origin filter
     */
    origin?: 'intake' | 'outbound';
  },
) {
  const db = getDb();
  // Only campaign-linked threads belong in the Inbox — never the operator's
  // own personal mail. Threads without a lead are not surfaced.
  const conds = [
    eq(emailThreads.workspaceId, workspaceId),
    isNotNull(emailThreads.leadId),
    // Operator-dismissed threads (right-click → Delete in Inbox) drop out
    // of the list. The Gmail thread + lead row are untouched; this is a
    // UnieSales-side dismissal only.
    sql`${emailThreads.dismissedAt} IS NULL`,
    // Also hide threads whose parent lead has been soft-deleted.
    inArray(
      emailThreads.leadId,
      db
        .select({ id: leads.id })
        .from(leads)
        .where(
          and(
            eq(leads.workspaceId, workspaceId),
            sql`${leads.deletedAt} IS NULL`,
          ),
        ),
    ),
  ];
  if (opts.campaignId) conds.push(eq(emailThreads.campaignId, opts.campaignId));

  // Origin filter — resolve via the linked lead's import_origin. Done as a
  // subquery so we don't have to join + DISTINCT on the main select.
  if (opts.origin === 'intake') {
    const intakeLeadIds = db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.workspaceId, workspaceId), eq(leads.importOrigin, 'intake')));
    conds.push(inArray(emailThreads.leadId, intakeLeadIds));
  } else if (opts.origin === 'outbound') {
    const outboundLeadIds = db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.workspaceId, workspaceId),
          sql`(${leads.importOrigin} IS NULL OR ${leads.importOrigin} <> 'intake')`,
        ),
      );
    conds.push(inArray(emailThreads.leadId, outboundLeadIds));
  }

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
        nextActionAt: leads.nextActionAt,
        painAngle: leads.painAngle,
        personalization: leads.personalization,
      })
      .from(leads)
      .where(eq(leads.id, t.leadId))
      .limit(1);
    lead = lRows[0] ?? null;
  }
  return { ...t, messages: msgs, lead };
}

/** All email threads for a single lead, each with its messages — for the lead modal. */
export async function listByLead(workspaceId: string, leadId: string): Promise<(EmailThread & { messages: EmailMessage[] })[]> {
  const db = getDb();
  const threads = await db
    .select()
    .from(emailThreads)
    .where(and(eq(emailThreads.workspaceId, workspaceId), eq(emailThreads.leadId, leadId)))
    .orderBy(desc(emailThreads.updatedAt));
  if (threads.length === 0) return [];

  const msgs = await db
    .select()
    .from(emailMessages)
    .where(and(eq(emailMessages.workspaceId, workspaceId), eq(emailMessages.leadId, leadId)))
    .orderBy(asc(emailMessages.createdAt));

  return threads.map((t) => ({
    ...t,
    messages: msgs.filter((m) => m.emailThreadId === t.id),
  }));
}

export async function handoff(workspaceId: string, threadId: string, reason?: string): Promise<EmailThread> {
  const db = getDb();
  const t = await getById(workspaceId, threadId);
  await db
    .update(emailThreads)
    .set({ aiOwner: false, status: 'handoff', updatedAt: new Date() })
    .where(eq(emailThreads.id, t.id));
  // Create (or update) the dedicated handoff record — this also flips the
  // linked lead to handoff_required.
  if (t.leadId) {
    await handoffService.create(workspaceId, {
      leadId: t.leadId,
      campaignId: t.campaignId,
      emailThreadId: t.id,
      reason: reason ?? `Escalated from thread "${t.subject ?? '(no subject)'}"`,
    });
  }
  const rows = await db.select().from(emailThreads).where(eq(emailThreads.id, t.id)).limit(1);
  return rows[0]!;
}

/**
 * Bulk-dismiss threads from the Inbox view. Sets `dismissed_at = now()`
 * so the list query (which filters `dismissed_at IS NULL`) stops returning
 * them. The underlying Gmail message + lead row are NOT modified — this is
 * purely a UnieSales-side "out of my inbox" gesture. Idempotent.
 *
 * Also stops the AI on those threads (aiOwner=false) so a future inbound
 * reply doesn't reanimate the dismissed thread.
 */
export async function bulkDismiss(
  workspaceId: string,
  threadIds: string[],
): Promise<{ dismissed: number }> {
  if (threadIds.length === 0) return { dismissed: 0 };
  const db = getDb();
  const result = await db
    .update(emailThreads)
    .set({
      dismissedAt: new Date(),
      aiOwner: false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(emailThreads.workspaceId, workspaceId),
        inArray(emailThreads.id, threadIds),
        sql`${emailThreads.dismissedAt} IS NULL`,
      ),
    )
    .returning({ id: emailThreads.id });
  return { dismissed: result.length };
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
