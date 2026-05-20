/**
 * Outbound gate. Every send path (manual send, followup worker, auto-reply)
 * calls canSend() first. Implements the 13-check list from the spec.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { workspaces } from '../db/schema/workspaces';
import { campaigns } from '../db/schema/campaigns';
import { gmailAccounts } from '../db/schema/gmail-accounts';
import { leads } from '../db/schema/leads';
import { campaignExitRules } from '../db/schema/campaign-exit-rules';
import { suppressionList } from '../db/schema/suppression-list';

export interface CanSendResult {
  allowed: boolean;
  reason?: string;
}

export interface CanSendInput {
  workspaceId: string;
  campaignId: string;
  leadId: string;
  gmailAccountId?: string;
  isAutoReply?: boolean;
  classification?: string;
  confidence?: number;
  toneIsAngry?: boolean;
  /** Classification result we'd send if this is an auto-reply. */
  replyMentions?: string[];
}

const UNSAFE_REPLY_TOPICS = [
  'pricing',
  'price',
  'cost',
  'contract',
  'legal',
  'revenue share',
  'loan terms',
  'custom implementation',
  'enterprise',
];

export async function canSend(input: CanSendInput): Promise<CanSendResult> {
  const db = getDb();

  const wsRow = (await db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1))[0];
  if (!wsRow || !wsRow.isActive) return { allowed: false, reason: 'workspace inactive' };

  const cRow = (
    await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.workspaceId, input.workspaceId), eq(campaigns.id, input.campaignId)))
      .limit(1)
  )[0];
  if (!cRow) return { allowed: false, reason: 'campaign not found' };
  if (cRow.status !== 'active') return { allowed: false, reason: `campaign status is ${cRow.status}` };

  const leadRow = (
    await db
      .select()
      .from(leads)
      .where(and(eq(leads.workspaceId, input.workspaceId), eq(leads.id, input.leadId)))
      .limit(1)
  )[0];
  if (!leadRow) return { allowed: false, reason: 'lead not found' };
  if (leadRow.lifecycleStatus !== 'active') return { allowed: false, reason: `lead is ${leadRow.lifecycleStatus}` };
  if (leadRow.pausedUntil && leadRow.pausedUntil > new Date()) {
    return { allowed: false, reason: 'lead is paused' };
  }

  // Suppression
  const supp = await db
    .select({ id: suppressionList.id })
    .from(suppressionList)
    .where(
      and(
        eq(suppressionList.workspaceId, input.workspaceId),
        sql`LOWER(${suppressionList.email}) = LOWER(${leadRow.email})`,
      ),
    )
    .limit(1);
  if (supp.length > 0) return { allowed: false, reason: 'lead email is on suppression list' };

  // Exit rules
  const erRow = (
    await db
      .select()
      .from(campaignExitRules)
      .where(
        and(eq(campaignExitRules.workspaceId, input.workspaceId), eq(campaignExitRules.campaignId, input.campaignId)),
      )
      .limit(1)
  )[0];
  if (erRow) {
    if (leadRow.emailAttemptCount >= erRow.maxEmailAttempts) {
      return { allowed: false, reason: 'max_email_attempts reached' };
    }
    if (leadRow.followupCount >= erRow.maxNoReplyFollowups) {
      return { allowed: false, reason: 'max_no_reply_followups reached' };
    }
    if (leadRow.firstContactedAt) {
      const daysIn = (Date.now() - leadRow.firstContactedAt.getTime()) / 86_400_000;
      if (daysIn >= erRow.maxDaysInSequence) {
        return { allowed: false, reason: 'max_days_in_sequence reached' };
      }
    }
  }

  // Gmail account
  const gmailAccountId = input.gmailAccountId ?? cRow.gmailAccountId;
  if (gmailAccountId) {
    const gaRow = (await db.select().from(gmailAccounts).where(eq(gmailAccounts.id, gmailAccountId)).limit(1))[0];
    if (!gaRow) return { allowed: false, reason: 'gmail account not found' };
    if (!gaRow.isActive) return { allowed: false, reason: 'gmail account inactive' };
    if (gaRow.healthStatus === 'at_risk' || gaRow.healthStatus === 'paused') {
      return { allowed: false, reason: `gmail health ${gaRow.healthStatus}` };
    }
    if (gaRow.dailySentCount >= gaRow.dailySendLimit) {
      return { allowed: false, reason: 'daily send limit reached for this gmail account' };
    }
  }

  // Auto-reply specific gates
  if (input.isAutoReply) {
    if (!wsRow.autoReplyEnabled) return { allowed: false, reason: 'workspace auto_reply disabled' };
    const threshold = Number(wsRow.autoReplyConfidenceThreshold);
    if (input.confidence == null || input.confidence < threshold) {
      return { allowed: false, reason: `confidence ${input.confidence} below threshold ${threshold}` };
    }
    if (input.toneIsAngry) return { allowed: false, reason: 'tone is angry or sensitive' };
    const mentions = (input.replyMentions ?? []).map((s) => s.toLowerCase());
    const unsafe = mentions.find((m) => UNSAFE_REPLY_TOPICS.some((t) => m.includes(t)));
    if (unsafe) return { allowed: false, reason: `reply mentions unsafe topic: ${unsafe}` };
  }

  return { allowed: true };
}
