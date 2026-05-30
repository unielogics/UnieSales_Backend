/**
 * Autonomous inbound-reply handling.
 *
 * When a campaign lead replies to one of our emails, the gmail worker calls
 * processInboundReply(). This is where the AI "nurtures and converts on its
 * own": it classifies the reply, cancels the now-stale scheduled cold
 * follow-up, advances the lead status, escalates sensitive replies to a
 * handoff, books a Google Meet on meeting requests, and either auto-sends a
 * contextual reply (when auto-reply is enabled + confident + safe) or queues a
 * draft for the operator to review in the Inbox.
 *
 * Import direction is one-way (reply.service → gmail/ai-tasks/calendar/handoff)
 * — the gmail WORKER orchestrates, so there is no circular import.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../config/db';
import { createLogger } from '../config/logger';
import { workspaces } from '../db/schema/workspaces';
import { aiActions } from '../db/schema/ai-actions';
import { leads, type LeadStatus } from '../db/schema/leads';
import * as threadService from './thread.service';
import * as leadService from './lead.service';
import * as handoffService from './handoff.service';
import * as suppressionService from './suppression.service';
import * as notify from './notification.service';
import { classifyReply, type ClassifyReplyOutput } from './ai-tasks.service';
import { sendEmail } from './gmail.service';
import { sendSmsToLead, toE164 } from './sms.service';
import {
  bookMeetingFromReply,
  computeAvailableSlots,
  getCalendarConfig,
  isWithinBookableHours,
  formatSlotLabel,
} from './calendar.service';

const log = createLogger(process.env.LOG_LEVEL ?? 'info').child({ service: 'reply' });

export type ReplyOutcome =
  | 'noop'
  | 'handed_off'
  | 'closed'
  | 'paused'
  | 'auto_replied'
  | 'draft_queued';

export interface ProcessInboundReplyInput {
  workspaceId: string;
  /** Our internal email_threads.id */
  threadId: string;
  leadId: string;
  campaignId: string;
}

export interface ProcessInboundReplyResult {
  outcome: ReplyOutcome;
  classification?: string;
  actionId?: string;
}

type Classification = ClassifyReplyOutput['classification'];

/** Classifications that mean the lead is done — close the lead. */
const CLOSE_STATUS_MAP: Partial<Record<Classification, LeadStatus>> = {
  not_interested: 'closed_not_interested',
  close_not_interested: 'closed_not_interested',
  close_bad_fit: 'closed_bad_fit',
  wrong_person: 'closed_wrong_person',
  close_wrong_person: 'closed_wrong_person',
  unsubscribe: 'closed_unsubscribed',
  close_unsubscribed: 'closed_unsubscribed',
  bounce: 'closed_bounced',
  close_bounced: 'closed_bounced',
};

/** Classifications that escalate straight to a human handoff. */
const HANDOFF_CLASSIFICATIONS = new Set<Classification>([
  'angry_or_sensitive',
  'handoff_required',
]);

/** Classifications that mean "pause and re-engage later". */
const PAUSE_CLASSIFICATIONS = new Set<Classification>([
  'out_of_office',
  'pause_out_of_office',
]);

/** Maps a (non-terminal) classification to the lead status to advance to. */
const STATUS_MAP: Partial<Record<Classification, LeadStatus>> = {
  positive_interest: 'interested',
  meeting_request: 'meeting_requested',
  call_scheduled: 'call_scheduled',
  send_more_info: 'info_sent',
  pricing_question: 'objection',
  objection_existing_system: 'objection',
  objection_not_now: 'objection',
  objection_cost: 'objection',
  objection_skeptical: 'objection',
  referral: 'replied',
  continue_nurture: 'replied',
  reactivation_candidate: 'replied',
  unknown_needs_review: 'replied',
};

/**
 * Process a single freshly-synced inbound reply end-to-end.
 * Safe to call more than once for the same thread — if the latest message is
 * already one of ours, it no-ops.
 */
export async function processInboundReply(
  input: ProcessInboundReplyInput,
): Promise<ProcessInboundReplyResult> {
  const { workspaceId, threadId, leadId, campaignId } = input;

  const thread = await threadService.getById(workspaceId, threadId);
  const messages = thread.messages;
  if (messages.length === 0) return { outcome: 'noop' };

  // If the most recent message is outbound, we've already answered this reply.
  const last = messages[messages.length - 1]!;
  if (last.direction === 'outbound') return { outcome: 'noop' };

  // 0. Hard bounce short-circuit. Mailer-Daemon / Postmaster replies are
  //    unambiguous — no AI needed. Close the lead, add the destination email
  //    to the workspace suppression list so future imports skip it and the
  //    canSend gate blocks any other lead carrying the same address.
  const senderLower = (last.fromEmail ?? '').toLowerCase();
  if (/(^|<|\s)(mailer-daemon|postmaster)@/i.test(senderLower)) {
    try {
      const lRow = (
        await getDb().select().from(leads).where(eq(leads.id, leadId)).limit(1)
      )[0];
      if (lRow?.email) {
        await suppressionService.suppressEmailAndCloseLeads(
          workspaceId,
          lRow.email,
          'mail_bounce',
        );
        log.info(
          { leadId, threadId, sender: senderLower, email: lRow.email },
          'inbound is a hard bounce — suppressed + closed, skipped classify',
        );
      }
    } catch (err) {
      log.error({ err, leadId }, 'bounce auto-suppress failed');
    }
    return { outcome: 'closed', classification: 'bounce' };
  }

  // 1. Classify the reply. The scheduling hint anchors relative-date parsing
  //    ("next Tuesday", "3pm") so a picked time resolves to a real instant.
  const calConfig = await getCalendarConfig(workspaceId);
  const { output: cls } = await classifyReply({
    workspaceId,
    campaignId,
    leadId,
    threadId,
    schedulingHint: { nowIso: new Date().toISOString(), timezone: calConfig.timezone },
    channel: thread.channel === 'sms' ? 'sms' : 'email',
  });
  const classification = cls.classification;
  log.info({ leadId, threadId, classification, confidence: cls.confidence }, 'reply classified');

  // Notify the operator on meaningful replies (mobile Alerts + push). One emit
  // up front covers all branches below; best-effort so it never blocks.
  {
    const isHandoff = cls.should_handoff || HANDOFF_CLASSIFICATIONS.has(classification);
    const isObjection = classification.startsWith('objection') || classification === 'pricing_question';
    const isPositive =
      classification === 'positive_interest' ||
      classification === 'meeting_request' ||
      classification === 'call_scheduled';
    if (isHandoff || isObjection || isPositive) {
      await notify.emit({
        workspaceId,
        leadId,
        threadId,
        kind: isHandoff ? 'handoff' : isObjection ? 'objection' : 'reply',
        priority: isHandoff ? 'urgent' : isObjection ? 'normal' : 'high',
        title: isHandoff ? 'Reply needs you' : isObjection ? 'Objection flagged' : 'Positive reply',
        body: cls.summary ? cls.summary.slice(0, 200) : null,
      });
    }
  }

  // Channel switch request: if the lead asked to be contacted on the other
  // channel, flip lead.channel so FUTURE outreach uses it. The auto-reply
  // below still goes back on whichever channel they messaged us on.
  if (cls.prefer_channel) {
    const lRow = (
      await getDb().select().from(leads).where(eq(leads.id, leadId)).limit(1)
    )[0];
    if (lRow) {
      const target = cls.prefer_channel;
      const hasRealEmail = !!lRow.email && !lRow.email.startsWith('sms+');
      const hasValidPhone = !!toE164(lRow.phone);
      const eligible =
        (target === 'email' && hasRealEmail && lRow.channel !== 'email') ||
        (target === 'sms' && hasValidPhone && lRow.channel !== 'sms');
      if (eligible) {
        await leadService.update(workspaceId, leadId, { channel: target });
        log.info({ leadId, from: lRow.channel, to: target }, 'channel switched per lead request');
      }
    }
  }

  // 2. Handoff — sensitive / high-value replies go to a human. handoffService
  //    flips the lead to handoff_required + aiOwner=false (stops follow-ups).
  if (cls.should_handoff || HANDOFF_CLASSIFICATIONS.has(classification)) {
    await handoffService.create(workspaceId, {
      leadId,
      campaignId,
      emailThreadId: threadId,
      reason:
        cls.handoff_summary ??
        cls.summary ??
        `Reply needs a human (${classification})`,
    });
    await cancelScheduledFollowup(workspaceId, leadId);
    return { outcome: 'handed_off', classification };
  }

  // 3. Close — the lead is done (not interested / wrong person / unsubscribe / bounce).
  const closeStatus = CLOSE_STATUS_MAP[classification];
  if (closeStatus || cls.should_stop_sequence) {
    await leadService.close(
      workspaceId,
      leadId,
      cls.close_reason ?? cls.summary ?? classification,
      closeStatus ?? 'closed_not_interested',
    );
    return { outcome: 'closed', classification };
  }

  // 4. Pause — out of office; re-engage in ~7 days.
  if (PAUSE_CLASSIFICATIONS.has(classification) || cls.should_pause) {
    const until = new Date(Date.now() + 7 * 24 * 3_600_000);
    await leadService.pause(workspaceId, leadId, until);
    return { outcome: 'paused', classification };
  }

  // 5. Build the reply, handling scheduling.
  //    - meeting_request → the lead wants to meet but hasn't picked a time:
  //      offer 2+1 real open calendar slots; do NOT book yet.
  //    - call_scheduled → the lead picked a time: book that exact slot (if it
  //      is bookable) and confirm; otherwise re-offer slots.
  const replySubject =
    cls.reply_subject ?? (thread.subject ? `Re: ${thread.subject}` : 'Re:');
  let replyBody = (cls.reply_body ?? '').trim();

  if (classification === 'call_scheduled' && cls.proposed_time) {
    const when = new Date(cls.proposed_time);
    if (isWithinBookableHours(when, calConfig)) {
      try {
        const booked = await bookMeetingFromReply({
          workspaceId,
          leadId,
          campaignId,
          emailThreadId: threadId,
          proposedTime: when,
        });
        const niceTime = formatSlotLabel(when, calConfig.timezone);
        const linkLine = booked.meetLink
          ? ` Here's the video link: ${booked.meetLink}`
          : '';
        replyBody =
          `${replyBody}\n\nYou're all set — I've sent a calendar invite for ${niceTime}.${linkLine}`.trim();
      } catch (err) {
        log.error({ err, leadId }, 'meeting auto-book failed');
        replyBody = await appendSlotOffer(workspaceId, replyBody);
      }
    } else {
      // The picked time falls outside working hours / a blocked window —
      // offer fresh open slots instead of booking something invalid.
      replyBody = await appendSlotOffer(workspaceId, replyBody);
    }
  } else if (classification === 'meeting_request') {
    replyBody = await appendSlotOffer(workspaceId, replyBody);
  }

  // 6. Decide: auto-send or queue a draft for the operator.
  const wsRows = await getDb()
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const ws = wsRows[0];
  const threshold = Number(ws?.autoReplyConfidenceThreshold ?? 0.85);
  // We can send the reply if the body is non-empty AND we have a channel:
  // SMS just needs the lead's phone (checked in sendSmsToLead); email needs
  // the thread's Gmail account.
  const canSend =
    replyBody.length > 0 &&
    (thread.channel === 'sms' ? true : !!thread.gmailAccountId);
  const autoSend =
    canSend &&
    cls.should_auto_reply &&
    !!ws?.autoReplyEnabled &&
    cls.confidence >= threshold;

  const nextStatus = STATUS_MAP[classification] ?? 'replied';

  if (autoSend) {
    if (thread.channel === 'sms') {
      await sendSmsToLead({ workspaceId, leadId, body: replyBody });
    } else {
      await sendEmail({
        workspaceId,
        gmailAccountId: thread.gmailAccountId!,
        to: thread.lead?.email ?? '',
        subject: replySubject,
        body: replyBody,
        threadId: thread.gmailThreadId ?? undefined,
        campaignId,
        leadId,
        bypassHealthGate: true,
        attachmentFileIds: cls.attachment_file_ids,
      });
    }
    // Reply sent → cancel the stale cold follow-up + advance the lead.
    await leadService.update(workspaceId, leadId, {
      status: nextStatus,
      nextActionAt: null,
    });
    log.info({ leadId, threadId, classification }, 'auto-replied');
    return { outcome: 'auto_replied', classification };
  }

  // Queue a draft in the AI queue for the operator to review + approve.
  const [queued] = await getDb()
    .insert(aiActions)
    .values({
      workspaceId,
      campaignId,
      leadId,
      emailThreadId: threadId,
      actionType: 'create_draft',
      status: 'pending',
      confidence: cls.confidence != null ? cls.confidence.toFixed(3) : null,
      reason: cls.summary ?? cls.recommended_next_action ?? null,
      aiOutput: {
        subject: replySubject,
        body: replyBody,
        attachmentFileIds: cls.attachment_file_ids,
      },
    })
    .returning();

  // Still cancel the stale cold follow-up + advance the lead — the queued draft
  // now owns the next contact, so the follow-up worker must not fire a generic
  // "just circling back" email over the top of it.
  await leadService.update(workspaceId, leadId, {
    status: nextStatus,
    nextActionAt: null,
  });
  log.info({ leadId, threadId, classification, actionId: queued?.id }, 'draft queued');
  return { outcome: 'draft_queued', classification, actionId: queued?.id };
}

/**
 * Append a list of real open calendar slots (2 next working day, 1 the day
 * after — per the workspace's calendar config) to a reply body. If the
 * calendar yields no slots, the body is returned unchanged.
 */
async function appendSlotOffer(workspaceId: string, body: string): Promise<string> {
  try {
    const { slots } = await computeAvailableSlots(workspaceId);
    if (slots.length === 0) return body;
    const lines = slots.map((s) => `  - ${s.label}`).join('\n');
    return (
      `${body}\n\nHere are a few times that work on my end:\n${lines}\n\n` +
      `Reply with whichever suits you and I'll send over a calendar invite.`
    ).trim();
  } catch (err) {
    log.error({ err, workspaceId }, 'slot computation failed');
    return body;
  }
}

/** Null out nextActionAt so the follow-up worker stops chasing this lead. */
async function cancelScheduledFollowup(workspaceId: string, leadId: string): Promise<void> {
  try {
    await leadService.update(workspaceId, leadId, { nextActionAt: null });
  } catch (err) {
    log.error({ err, leadId }, 'failed to cancel scheduled followup');
  }
}
