/**
 * Step 11 — Send test emails & Activate ("Playground").
 *
 * Operator sends one-off test emails through the full AI pipeline (draft +
 * Gmail send) to verify how the campaign will read. Test sends are explicitly
 * isolated:
 *   - Resulting leads are stamped `source = 'playground_test'`.
 *   - The followup worker excludes that source — test leads never get
 *     auto-followups, never count against daily quota.
 *   - Test sending **does not** activate the campaign or touch its status.
 *     Activation is its own button that runs the 12-check gate (campaign.service.ts).
 *
 * Prior behaviour auto-flipped `campaigns.status = active, warmupMode = true`
 * on first send, which silently started the followup worker against real
 * imported leads — that was the source of the "warming up with real leads"
 * incident on 2026-05-26. Removed.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { leads, type Lead, type LeadStatus, type NewLead } from '../db/schema/leads';
import { type Campaign } from '../db/schema/campaigns';
import { campaignPlaybooks } from '../db/schema/campaign-playbooks';
import { campaignExitRules } from '../db/schema/campaign-exit-rules';
import { campaignLeadSources } from '../db/schema/campaign-lead-sources';
import { gmailAccounts, type GmailAccount } from '../db/schema/gmail-accounts';
import { emailMessages } from '../db/schema/email-messages';
import { emailThreads } from '../db/schema/email-threads';
import { aiActions } from '../db/schema/ai-actions';
import { calendarEvents } from '../db/schema/calendar-events';
import { ConflictError, NotFoundError, type ErrorDetail } from '../utils/errors';
import * as campaignService from './campaign.service';
import * as suppressionService from './suppression.service';
import { generateEmail, type GenerateEmailOutput } from './ai-tasks.service';
import { sendEmail } from './gmail.service';

export interface PlaygroundSendInput {
  workspaceId: string;
  campaignId: string;
  email: string;
  contactName?: string;
  companyName?: string;
  title?: string;
  sourceNotes?: string;
  gmailAccountId?: string;
  subjectOverride?: string;
  bodyOverride?: string;
}

export interface PlaygroundSendResult {
  lead: Lead;
  sentMessage: {
    id: string;
    gmailMessageId: string;
    gmailThreadId: string;
    subject: string;
    body: string;
  };
  draft: GenerateEmailOutput | null;
  campaignActivated: boolean;
}

/**
 * Lean subset of the activation gate: just the things needed for a real send
 * to flow end-to-end (playbook + gmail + lead source + exit rules). The full
 * 12-check gate is intentionally NOT used here — the whole point of step 11
 * is that you can warm up before the full launch checklist is green.
 */
async function checkPlaygroundPrereqs(workspaceId: string, campaignId: string): Promise<ErrorDetail[]> {
  const db = getDb();
  const blockers: ErrorDetail[] = [];

  const pb = await db
    .select()
    .from(campaignPlaybooks)
    .where(and(eq(campaignPlaybooks.workspaceId, workspaceId), eq(campaignPlaybooks.campaignId, campaignId)))
    .limit(1);
  if (pb.length === 0) {
    blockers.push({ field: 'playbook', reason: 'campaign playbook has not been generated' });
  } else if (pb[0]!.approvalStatus !== 'approved') {
    blockers.push({ field: 'playbook', reason: 'campaign playbook has not been approved' });
  }

  const ga = await db
    .select()
    .from(gmailAccounts)
    .where(and(eq(gmailAccounts.workspaceId, workspaceId), eq(gmailAccounts.isActive, true)))
    .limit(1);
  if (ga.length === 0) {
    blockers.push({ field: 'gmail_account', reason: 'no active Gmail account on this workspace' });
  }

  const ls = await db
    .select()
    .from(campaignLeadSources)
    .where(
      and(
        eq(campaignLeadSources.workspaceId, workspaceId),
        eq(campaignLeadSources.campaignId, campaignId),
        eq(campaignLeadSources.isActive, true),
      ),
    )
    .limit(1);
  if (ls.length === 0) {
    blockers.push({ field: 'lead_source', reason: 'no active lead source attached' });
  }

  const er = await db
    .select()
    .from(campaignExitRules)
    .where(and(eq(campaignExitRules.workspaceId, workspaceId), eq(campaignExitRules.campaignId, campaignId)))
    .limit(1);
  if (er.length === 0) {
    blockers.push({ field: 'exit_rules', reason: 'exit rules have not been configured' });
  }

  return blockers;
}

async function resolveGmailAccount(
  workspaceId: string,
  campaign: Campaign,
  override?: string,
): Promise<GmailAccount> {
  const db = getDb();
  if (override) {
    const r = await db.select().from(gmailAccounts).where(eq(gmailAccounts.id, override)).limit(1);
    if (!r[0] || r[0].workspaceId !== workspaceId) throw new NotFoundError('Gmail account not found');
    if (!r[0].isActive) throw new ConflictError('Selected Gmail account is not active');
    return r[0];
  }
  if (campaign.gmailAccountId) {
    const r = await db.select().from(gmailAccounts).where(eq(gmailAccounts.id, campaign.gmailAccountId)).limit(1);
    if (r[0] && r[0].isActive) return r[0];
  }
  const r = await db
    .select()
    .from(gmailAccounts)
    .where(and(eq(gmailAccounts.workspaceId, workspaceId), eq(gmailAccounts.isActive, true)))
    .orderBy(desc(gmailAccounts.createdAt))
    .limit(1);
  if (!r[0]) throw new ConflictError('No active Gmail account on this workspace');
  return r[0];
}

/**
 * Find an existing playground lead in this campaign by email (case-insensitive),
 * or insert a new one. Mirrors the de-dupe behavior of the unique
 * (workspace_id, lower(email), campaign_id) index.
 */
async function findOrCreateLead(input: PlaygroundSendInput, gmailAccountId: string): Promise<Lead> {
  const db = getDb();
  const lowered = input.email.trim().toLowerCase();

  if (await suppressionService.isSuppressed(input.workspaceId, lowered)) {
    throw new ConflictError('Email is on the suppression list', [
      { field: 'email', reason: 'suppressed in this workspace' },
    ]);
  }

  const existing = await db
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, input.workspaceId),
        eq(leads.campaignId, input.campaignId),
        sql`LOWER(${leads.email}) = ${lowered}`,
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  const rows = await db
    .insert(leads)
    .values({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      gmailAccountId,
      email: lowered,
      contactName: input.contactName ?? null,
      companyName: input.companyName ?? null,
      title: input.title ?? null,
      sourceNotes: input.sourceNotes ?? null,
      // 'playground_test' is the source filter the followup worker excludes,
      // so test sends never get auto-followups. Distinct from any legacy
      // 'playground' rows (still filtered out for safety).
      source: 'playground_test',
      status: 'pending_review' as LeadStatus,
    } as NewLead)
    .returning();
  return rows[0]!;
}

export async function runPlaygroundSend(input: PlaygroundSendInput): Promise<PlaygroundSendResult> {
  const db = getDb();

  // 1. Prereq gate
  const blockers = await checkPlaygroundPrereqs(input.workspaceId, input.campaignId);
  if (blockers.length > 0) {
    throw new ConflictError('Cannot send warm-up email yet', blockers);
  }

  // 2. Campaign + gmail account
  const campaign = await campaignService.getByIdOrThrow(input.workspaceId, input.campaignId);
  if (campaign.status === 'archived') {
    throw new ConflictError('Cannot send from an archived campaign', [
      { field: 'campaign.status', reason: 'campaign is archived' },
    ]);
  }
  const account = await resolveGmailAccount(input.workspaceId, campaign, input.gmailAccountId);

  // 3. Find or create the lead (stamped source='playground_test')
  const lead = await findOrCreateLead(input, account.id);

  // 4. Build subject/body. Use overrides if both supplied, else AI draft.
  let draft: GenerateEmailOutput | null = null;
  let subject: string;
  let body: string;
  if (input.subjectOverride && input.bodyOverride) {
    subject = input.subjectOverride;
    body = input.bodyOverride;
  } else {
    const ai = await generateEmail({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      leadId: lead.id,
      stage: 'cold',
    });
    draft = ai.output;
    subject = input.subjectOverride ?? ai.output.subject;
    body = input.bodyOverride ?? ai.output.body;
  }

  // 5. Send via Gmail. If this throws, the lead stays in pending_review.
  const sent = await sendEmail({
    workspaceId: input.workspaceId,
    gmailAccountId: account.id,
    to: lead.email,
    subject,
    body,
    campaignId: input.campaignId,
    leadId: lead.id,
    // Warm-up sends go out even when reputation is at-risk — that's the point.
    bypassHealthGate: true,
  });

  // 6. Update lead: status=sent_email_1, timestamps, attempts++.
  //    next_action_at = null — test sends NEVER schedule an auto-followup.
  //    The whole point of this view is "see what an email would look like",
  //    not "kick off a real cadence". The followup worker also filters out
  //    source='playground_test' as belt-and-suspenders.
  const now = new Date();
  const updatedLeadRows = await db
    .update(leads)
    .set({
      status: 'sent_email_1',
      firstContactedAt: lead.firstContactedAt ?? now,
      lastContactedAt: now,
      lastEngagementAt: now,
      nextActionAt: null,
      emailAttemptCount: lead.emailAttemptCount + 1,
      gmailThreadId: sent.gmailThreadId,
      updatedAt: now,
    })
    .where(eq(leads.id, lead.id))
    .returning();
  const updatedLead = updatedLeadRows[0]!;

  // (Test sending NEVER mutates campaign status. Activation is a separate,
  // explicit button on the same page that runs the full 12-check gate via
  // campaign.service.activate(). The old "implicit go-live into warmup" block
  // that lived here is gone — it caused real imported leads to be sent
  // before the operator had a chance to review the campaign.)
  const campaignActivated = false;

  // 8. Look up the persisted outbound email_messages row we just inserted
  //    (sendEmail did the insert; we just need the id for the response)
  const msgRow = await db
    .select()
    .from(emailMessages)
    .where(eq(emailMessages.gmailMessageId, sent.gmailMessageId))
    .limit(1);

  return {
    lead: updatedLead,
    sentMessage: {
      id: msgRow[0]?.id ?? '',
      gmailMessageId: sent.gmailMessageId,
      gmailThreadId: sent.gmailThreadId,
      subject,
      body,
    },
    draft,
    campaignActivated,
  };
}

export interface PlaygroundLeadRow extends Lead {
  lastSentSubject: string | null;
  lastSentAt: Date | null;
}

export async function listPlaygroundLeads(workspaceId: string, campaignId: string): Promise<PlaygroundLeadRow[]> {
  const db = getDb();
  const items = await db
    .select({
      lead: leads,
      lastSentSubject: sql<string | null>`(
        SELECT ${emailMessages.subject}
        FROM ${emailMessages}
        WHERE ${emailMessages.leadId} = ${leads.id}
          AND ${emailMessages.direction} = 'outbound'
        ORDER BY ${emailMessages.createdAt} DESC
        LIMIT 1
      )`,
      lastSentAt: sql<Date | null>`(
        SELECT ${emailMessages.createdAt}
        FROM ${emailMessages}
        WHERE ${emailMessages.leadId} = ${leads.id}
          AND ${emailMessages.direction} = 'outbound'
        ORDER BY ${emailMessages.createdAt} DESC
        LIMIT 1
      )`,
    })
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, workspaceId),
        eq(leads.campaignId, campaignId),
        // Surface both new test leads and any legacy 'playground' rows from
        // before the warm-up removal so the operator's history isn't lost.
        inArray(leads.source, ['playground_test', 'playground']),
      ),
    )
    .orderBy(desc(leads.createdAt))
    .limit(50);

  return items.map((r) => ({ ...r.lead, lastSentSubject: r.lastSentSubject, lastSentAt: r.lastSentAt }));
}

export async function getPrereqStatus(workspaceId: string, campaignId: string): Promise<{ allowed: boolean; blockers: ErrorDetail[] }> {
  const blockers = await checkPlaygroundPrereqs(workspaceId, campaignId);
  return { allowed: blockers.length === 0, blockers };
}

/**
 * Restart a warm-up: regenerate + re-send the email with whatever the
 * playbook / style guide / footer currently say, then retire the previous
 * warm-up's in-app records.
 *
 * The re-send runs FIRST — only once it succeeds do we delete the prior
 * thread/messages. If the send fails, nothing is destroyed and the error is
 * surfaced. (The original email already left Gmail and can't be recalled;
 * this only clears the in-app tracking.)
 */
export async function restartPlaygroundSend(input: {
  workspaceId: string;
  campaignId: string;
  leadId: string;
}): Promise<PlaygroundSendResult> {
  const db = getDb();
  const leadRows = await db
    .select()
    .from(leads)
    .where(and(eq(leads.workspaceId, input.workspaceId), eq(leads.id, input.leadId)))
    .limit(1);
  const lead = leadRows[0];
  if (!lead) throw new NotFoundError('Lead not found');
  if (lead.campaignId !== input.campaignId) {
    throw new ConflictError('Lead does not belong to this campaign');
  }
  if (lead.source !== 'playground_test' && lead.source !== 'playground') {
    throw new ConflictError('Only test-send leads can be re-sent');
  }

  // Snapshot the pre-restart threads so we can clean them up *after* a
  // successful re-send — never destroy data before the new email is sent.
  const oldThreads = await db
    .select({ id: emailThreads.id })
    .from(emailThreads)
    .where(and(eq(emailThreads.workspaceId, input.workspaceId), eq(emailThreads.leadId, input.leadId)));
  const oldThreadIds = oldThreads.map((t) => t.id);

  // Re-send first. If this throws, the prior warm-up is left fully intact.
  const result = await runPlaygroundSend({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    email: lead.email,
  });

  // Re-send succeeded → retire the previous warm-up's records.
  if (oldThreadIds.length > 0) {
    await db
      .update(aiActions)
      .set({ emailThreadId: null })
      .where(inArray(aiActions.emailThreadId, oldThreadIds));
    await db
      .update(calendarEvents)
      .set({ emailThreadId: null })
      .where(inArray(calendarEvents.emailThreadId, oldThreadIds));
    await db.delete(emailMessages).where(inArray(emailMessages.emailThreadId, oldThreadIds));
    await db.delete(emailThreads).where(inArray(emailThreads.id, oldThreadIds));
  }
  return result;
}
