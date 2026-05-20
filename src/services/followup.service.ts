/**
 * Follow-up sequencer. Per spec:
 *   Email 1:    Day 0
 *   Follow-up 1: Day 2
 *   Follow-up 2: Day 5
 *   Follow-up 3: Day 8
 *   Breakup:    Day 12
 */
import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { leads, type Lead, type LeadStatus } from '../db/schema/leads';
import { campaigns } from '../db/schema/campaigns';
import { canSend } from './exit-rules.service';
import { generateEmail } from './ai-tasks.service';
import { sendEmail } from './gmail.service';

// stage → days from now for next_action_at
const NEXT_STAGE_DAYS: Record<string, number> = {
  new: 0,
  pending_review: 0,
  ready_to_score: 0,
  scored: 0,
  ready_to_send: 0,
  sent_email_1: 2,
  sent_followup_1: 3, // day 5 = 2 + 3
  sent_followup_2: 3, // day 8 = 5 + 3
  sent_followup_3: 4, // day 12 = 8 + 4
};

function nextStatus(current: LeadStatus): LeadStatus | null {
  switch (current) {
    case 'ready_to_send':
    case 'scored':
    case 'pending_review':
    case 'new':
      return 'sent_email_1';
    case 'sent_email_1':
      return 'sent_followup_1';
    case 'sent_followup_1':
      return 'sent_followup_2';
    case 'sent_followup_2':
      return 'sent_followup_3';
    case 'sent_followup_3':
      return 'closed_no_response'; // breakup — last attempt
    default:
      return null;
  }
}

function stageLabel(status: LeadStatus): 'cold' | 'followup_1' | 'followup_2' | 'followup_3' | 'breakup' {
  switch (status) {
    case 'sent_email_1':
      return 'followup_1';
    case 'sent_followup_1':
      return 'followup_2';
    case 'sent_followup_2':
      return 'followup_3';
    case 'sent_followup_3':
      return 'breakup';
    default:
      return 'cold';
  }
}

export interface FollowupRunStats {
  scanned: number;
  sent: number;
  blocked: number;
  errors: number;
}

/** Pick due leads, run the gate, generate via AI, send via Gmail. */
export async function runFollowups(opts: { workspaceId?: string; limit?: number } = {}): Promise<FollowupRunStats> {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 25, 200);

  const conds = [
    eq(leads.lifecycleStatus, 'active'),
    eq(leads.aiOwner, true),
    isNotNull(leads.nextActionAt),
    lte(leads.nextActionAt, new Date()),
    isNotNull(leads.campaignId),
  ];
  if (opts.workspaceId) conds.push(eq(leads.workspaceId, opts.workspaceId));

  const dueLeads = await db
    .select()
    .from(leads)
    .where(and(...conds))
    .limit(limit);

  const stats: FollowupRunStats = { scanned: dueLeads.length, sent: 0, blocked: 0, errors: 0 };

  for (const lead of dueLeads) {
    try {
      const sent = await runOne(lead);
      if (sent) stats.sent++;
      else stats.blocked++;
    } catch {
      stats.errors++;
    }
  }
  return stats;
}

async function runOne(lead: Lead): Promise<boolean> {
  const db = getDb();
  if (!lead.campaignId) return false;

  const cRow = (await db.select().from(campaigns).where(eq(campaigns.id, lead.campaignId)).limit(1))[0];
  if (!cRow || cRow.status !== 'active' || !cRow.gmailAccountId) return false;

  const gate = await canSend({
    workspaceId: lead.workspaceId,
    campaignId: lead.campaignId,
    leadId: lead.id,
    gmailAccountId: cRow.gmailAccountId,
  });
  if (!gate.allowed) {
    // Clear next_action_at so we don't immediately re-scan this lead
    await db
      .update(leads)
      .set({ nextActionAt: null, updatedAt: new Date() })
      .where(eq(leads.id, lead.id));
    return false;
  }

  const stage = stageLabel(lead.status as LeadStatus);
  const ai = await generateEmail({
    workspaceId: lead.workspaceId,
    campaignId: lead.campaignId,
    leadId: lead.id,
    stage,
  });

  // Continue the existing thread if one exists, else start a new one
  await sendEmail({
    workspaceId: lead.workspaceId,
    gmailAccountId: cRow.gmailAccountId,
    to: lead.email,
    subject: ai.output.subject,
    body: ai.output.body,
    campaignId: lead.campaignId,
    leadId: lead.id,
    threadId: lead.gmailThreadId ?? undefined,
  });

  const newStatus = nextStatus(lead.status as LeadStatus);
  const stageKey = newStatus ?? lead.status;
  const daysAhead = NEXT_STAGE_DAYS[stageKey] ?? 0;
  const next = daysAhead > 0 ? new Date(Date.now() + daysAhead * 86_400_000) : null;

  await db
    .update(leads)
    .set({
      status: newStatus ?? lead.status,
      emailAttemptCount: lead.emailAttemptCount + 1,
      followupCount: lead.status === 'ready_to_send' ? lead.followupCount : lead.followupCount + 1,
      lastContactedAt: new Date(),
      firstContactedAt: lead.firstContactedAt ?? new Date(),
      nextActionAt: next,
      noReplyCount: lead.noReplyCount + (lead.status !== 'ready_to_send' ? 1 : 0),
      updatedAt: new Date(),
    })
    .where(eq(leads.id, lead.id));

  return true;
}

/** Queue a lead for the next send: sets next_action_at = now. */
export async function queueImmediate(workspaceId: string, leadId: string): Promise<void> {
  const db = getDb();
  await db
    .update(leads)
    .set({ nextActionAt: new Date(), updatedAt: new Date() })
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)));
}

export { sql };
