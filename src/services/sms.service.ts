/**
 * SMS channel — the "Gmail equivalent" for the SMS channel.
 *
 *   - findLeadByPhone:        match an inbound number back to a campaign lead.
 *   - findOrCreateSmsThread:  one SMS thread per lead (the thread tables are
 *                             channel-aware; SMS rows have channel='sms' and
 *                             a NULL gmail_thread_id).
 *   - recordInboundSms:       persist an inbound SMS as an email_messages row
 *                             and report whether it needs reply-pipeline work.
 *   - sendSmsToLead:          outbound — send via Twilio + persist the message.
 *   - isStopKeyword:          STOP/UNSUBSCRIBE etc. for opt-out handling.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { leads, type Lead } from '../db/schema/leads';
import { emailThreads, type EmailThread } from '../db/schema/email-threads';
import { emailMessages } from '../db/schema/email-messages';
import { env } from '../config/env';
import { createLogger } from '../config/logger';
import { sendSms } from './twilio.service';
import { ConflictError, NotFoundError } from '../utils/errors';
import { recordCostEvent } from './cost.service';

const log = createLogger(process.env.LOG_LEVEL ?? 'info').child({ service: 'sms' });

/** Digits-only, last 10 chars — US-centric matching key. */
function phoneLast10(raw: string | null | undefined): string {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

function smsSegments(body: string): number {
  return Math.max(1, Math.ceil((body || '').length / 160));
}

/** Best-effort E.164 normalization (US default if no country code). */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) digits = '1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.length > 11) return '+' + digits;
  return null;
}

/**
 * Match an inbound SMS to the most-recently-updated lead with the same
 * normalized phone (last 10 digits). Cross-workspace — the lead's
 * workspace_id is what we use to scope the rest of the pipeline.
 */
export async function findLeadByPhoneAnywhere(fromNumber: string): Promise<Lead | null> {
  const last10 = phoneLast10(fromNumber);
  if (!last10) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(leads)
    .where(
      sql`length(regexp_replace(coalesce(phone,''), '\D', '', 'g')) >= 10 AND right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 10) = ${last10}`,
    )
    .orderBy(sql`${leads.updatedAt} DESC`)
    .limit(1);
  return rows[0] ?? null;
}

/** A meaningful "subject" for an SMS thread — used wherever the inbox shows
 *  a row title. SMS conversations don't have a real subject, so we lift the
 *  lead's identity into that slot. */
function smsThreadLabel(lead: Lead): string {
  const phone = lead.phone ?? '';
  return lead.contactName || lead.companyName || phone || 'SMS conversation';
}

/** One SMS thread per lead — find it or create it. */
export async function findOrCreateSmsThread(workspaceId: string, lead: Lead): Promise<EmailThread> {
  const db = getDb();
  const existing = await db
    .select()
    .from(emailThreads)
    .where(
      and(
        eq(emailThreads.workspaceId, workspaceId),
        eq(emailThreads.leadId, lead.id),
        eq(emailThreads.channel, 'sms'),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  const [created] = await db
    .insert(emailThreads)
    .values({
      workspaceId,
      leadId: lead.id,
      campaignId: lead.campaignId ?? null,
      channel: 'sms',
      gmailThreadId: null,
      subject: smsThreadLabel(lead),
      status: 'active',
      aiOwner: true,
    })
    .returning();
  return created!;
}

export interface InboundSmsResult {
  thread: EmailThread;
  lead: Lead;
  newInboundReply: { threadId: string; leadId: string; campaignId: string } | null;
}

/** Persist an inbound SMS row and report what the reply pipeline should do. */
export async function recordInboundSms(input: {
  fromNumber: string;
  toNumber: string;
  body: string;
  twilioMessageSid: string;
}): Promise<InboundSmsResult | null> {
  const lead = await findLeadByPhoneAnywhere(input.fromNumber);
  if (!lead) {
    log.warn({ from: input.fromNumber, sid: input.twilioMessageSid }, 'inbound SMS: no matching lead');
    return null;
  }
  const thread = await findOrCreateSmsThread(lead.workspaceId, lead);
  const db = getDb();

  // De-dup if Twilio retries the same MessageSid.
  const dup = await db
    .select({ id: emailMessages.id })
    .from(emailMessages)
    .where(eq(emailMessages.twilioMessageSid, input.twilioMessageSid))
    .limit(1);
  if (dup[0]) {
    return { thread, lead, newInboundReply: null };
  }

  const [messageRow] = await db.insert(emailMessages).values({
    workspaceId: lead.workspaceId,
    campaignId: lead.campaignId ?? null,
    leadId: lead.id,
    emailThreadId: thread.id,
    channel: 'sms',
    direction: 'inbound',
    fromEmail: input.fromNumber,
    toEmail: input.toNumber,
    subject: null,
    body: input.body,
    twilioMessageSid: input.twilioMessageSid,
  }).returning({ id: emailMessages.id, createdAt: emailMessages.createdAt });
  if (messageRow) {
    await recordCostEvent({
      workspaceId: lead.workspaceId,
      campaignId: lead.campaignId ?? null,
      leadId: lead.id,
      emailThreadId: thread.id,
      emailMessageId: messageRow.id,
      sourceObjectType: 'email_message',
      sourceObjectId: messageRow.id,
      dedupeKey: `message:${messageRow.id}:sms_segment`,
      provider: 'twilio',
      service: 'sms',
      category: 'messaging',
      actionType: 'sms_segment',
      channel: 'sms',
      quantity: smsSegments(input.body),
      unit: 'segment',
      costSource: 'estimated',
      occurredAt: messageRow.createdAt,
      metadata: { direction: 'inbound', twilioMessageSid: input.twilioMessageSid },
    }).catch((err) => log.warn({ err }, 'cost record failed for inbound SMS'));
  }
  await db
    .update(emailThreads)
    .set({ updatedAt: new Date(), lastInboundAt: new Date() })
    .where(eq(emailThreads.id, thread.id));

  return {
    thread,
    lead,
    newInboundReply: lead.campaignId
      ? { threadId: thread.id, leadId: lead.id, campaignId: lead.campaignId }
      : null,
  };
}

/** Send an SMS to a lead, persisting the outbound row + advancing the thread. */
export async function sendSmsToLead(input: {
  workspaceId: string;
  leadId: string;
  body: string;
}): Promise<{ messageId: string; twilioSid: string }> {
  const db = getDb();
  const rows = await db
    .select()
    .from(leads)
    .where(and(eq(leads.workspaceId, input.workspaceId), eq(leads.id, input.leadId)))
    .limit(1);
  const lead = rows[0];
  if (!lead) throw new NotFoundError('Lead not found');
  const to = toE164(lead.phone);
  if (!to) throw new ConflictError('Lead has no valid phone number for SMS');

  const thread = await findOrCreateSmsThread(input.workspaceId, lead);
  const statusCallback = `${env().APP_BASE_URL.replace(/\/+$/, '')}/twilio/status`;
  const sent = await sendSms({ to, body: input.body, statusCallback });

  const [msg] = await db
    .insert(emailMessages)
    .values({
      workspaceId: input.workspaceId,
      campaignId: lead.campaignId ?? null,
      leadId: lead.id,
      emailThreadId: thread.id,
      channel: 'sms',
      direction: 'outbound',
      fromEmail: env().TWILIO_FROM_NUMBER || null,
      toEmail: to,
      subject: null,
      body: input.body,
      twilioMessageSid: sent.sid,
    })
    .returning({ id: emailMessages.id, createdAt: emailMessages.createdAt });

  if (msg) {
    await recordCostEvent({
      workspaceId: input.workspaceId,
      campaignId: lead.campaignId ?? null,
      leadId: lead.id,
      emailThreadId: thread.id,
      emailMessageId: msg.id,
      sourceObjectType: 'email_message',
      sourceObjectId: msg.id,
      dedupeKey: `message:${msg.id}:sms_segment`,
      provider: 'twilio',
      service: 'sms',
      category: 'messaging',
      actionType: 'sms_segment',
      channel: 'sms',
      quantity: smsSegments(input.body),
      unit: 'segment',
      costSource: 'estimated',
      occurredAt: msg.createdAt,
      metadata: { direction: 'outbound', twilioMessageSid: sent.sid },
    }).catch((err) => log.warn({ err }, 'cost record failed for outbound SMS'));
  }

  await db
    .update(emailThreads)
    .set({ updatedAt: new Date(), lastOutboundAt: new Date() })
    .where(eq(emailThreads.id, thread.id));

  log.info({ leadId: lead.id, sid: sent.sid }, 'sms sent to lead');
  return { messageId: msg!.id, twilioSid: sent.sid };
}

// ---- Opt-out ----

const STOP_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);

export function isStopKeyword(body: string | null | undefined): boolean {
  const b = (body ?? '').trim().toUpperCase();
  return !!b && STOP_KEYWORDS.has(b);
}
