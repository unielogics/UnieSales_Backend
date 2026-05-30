/**
 * Follow-up sequencer. Per spec:
 *   Email 1:    Day 0
 *   Follow-up 1: Day 2
 *   Follow-up 2: Day 5
 *   Follow-up 3: Day 8
 *   Breakup:    Day 12
 */
import { and, desc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { leads, type Lead, type LeadStatus } from '../db/schema/leads';
import { campaigns } from '../db/schema/campaigns';
import { gmailAccounts } from '../db/schema/gmail-accounts';
import { emailMessages } from '../db/schema/email-messages';
import { canSend } from './exit-rules.service';
import { generateEmail } from './ai-tasks.service';
import { sendEmail } from './gmail.service';
import { sendSmsToLead, toE164 } from './sms.service';
import { getCalendarConfig } from './calendar.service';
import { activateScheduledCampaigns } from './campaign.service';
import { createLogger } from '../config/logger';
import { ConflictError } from '../utils/errors';

/**
 * Decide whether a sendEmail throw is the recipient's fault (mark the lead's
 * email as failed) vs an account / infrastructure problem (do not penalize
 * the lead; the next run will retry).
 *
 * Recipient failures: 400/404/5xx Gmail responses whose error text mentions
 * the address being invalid, the recipient being unknown, the domain being
 * unreachable, bounces, etc.
 *
 * Account failures: our own ConflictErrors (paused, at_risk, daily-limit)
 * plus auth/scope errors — these come back as Anthropic-style structured
 * errors or plain Errors with generic messages.
 */
function isRecipientFailure(err: unknown): boolean {
  // Our own thrown errors for account-level problems must NOT mark the lead.
  if (err instanceof ConflictError) return false;
  if (!(err instanceof Error)) return false;
  const msg = (err.message ?? '').toLowerCase();
  // Patterns Gmail and SMTP relays use to signal recipient-specific failures.
  // Conservative regex — false negatives are fine (operator can manually
  // delete the lead); false positives would silently drop real sends.
  return (
    msg.includes('invalid to') ||
    msg.includes('invalid recipient') ||
    msg.includes('invalid email') ||
    msg.includes('no such user') ||
    msg.includes('no such address') ||
    msg.includes('address not found') ||
    msg.includes('user unknown') ||
    msg.includes('mailbox unavailable') ||
    msg.includes('mailbox not found') ||
    msg.includes('recipient address rejected') ||
    msg.includes('does not exist') ||
    msg.includes('domain not found') ||
    msg.includes('host or domain name not found') ||
    msg.includes('permanent failure')
  );
}

function describeSendFailure(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}

const log = createLogger(process.env.LOG_LEVEL ?? 'info').child({ service: 'followup' });

/** Current "HH:MM" wall-clock in the given IANA timezone. */
function currentHHMMInTz(tz: string): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date())) parts[p.type] = p.value;
  return `${parts.hour ?? '00'}:${parts.minute ?? '00'}`;
}

/** True if "now" (in tz) sits inside the quiet window (which may wrap midnight). */
function isWithinQuietHours(tz: string, start: string, end: string): boolean {
  if (!start || !end || start === end) return false;
  const now = currentHHMMInTz(tz);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

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
  coldQueued: number;
}

/** Lead statuses that are eligible for a first ("cold") send. */
const COLD_STATUSES: LeadStatus[] = [
  'new',
  'pending_review',
  'ready_to_score',
  'scored',
  'ready_to_send',
];

/**
 * Roll a Gmail account's daily_sent_count back to 0 once per calendar day.
 * Without this the counter only ever climbs and sends jam permanently.
 */
async function resetStaleDailyCounts(): Promise<void> {
  const db = getDb();
  // The "day" rolls over at the workspace's calendar-timezone midnight, so
  // the daily send budget aligns with the operator's day (and the dashboard's
  // daily numbers), not UTC midnight.
  await db.execute(sql`
    UPDATE gmail_accounts ga
    SET daily_sent_count = 0, daily_count_reset_at = now(), updated_at = now()
    FROM workspaces w
    WHERE ga.workspace_id = w.id
      AND (
        ga.daily_count_reset_at IS NULL
        OR ga.daily_count_reset_at <
           date_trunc('day', now() AT TIME ZONE COALESCE(w.calendar_config->>'timezone', 'America/New_York'))
           AT TIME ZONE COALESCE(w.calendar_config->>'timezone', 'America/New_York')
      )
  `);
}

/**
 * Cold-start: an active campaign's never-contacted leads sit at pending_review
 * with no next_action_at, so the follow-up scan never sees them. Each tick,
 * queue a slice of them (set next_action_at = now) sized to the remaining
 * daily send budget — this is what makes an active campaign actually send.
 */
async function queueColdStart(workspaceId?: string): Promise<number> {
  const db = getDb();
  const campConds = [eq(campaigns.status, 'active')];
  if (workspaceId) campConds.push(eq(campaigns.workspaceId, workspaceId));
  const activeCampaigns = await db.select().from(campaigns).where(and(...campConds));

  let queued = 0;
  for (const c of activeCampaigns) {
    // Defence-in-depth: never cold-queue from a campaign that's still flagged
    // warm-up. The current code path that set this flag was removed, but any
    // stale rows from before that fix would otherwise auto-send real leads
    // the moment the worker ticked. Skip them.
    if (c.warmupMode) continue;
    // Per-campaign budget — outbound (any channel) today in the workspace's
    // timezone. canSend handles gmail-specific gates per send.
    const [todayRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailMessages)
      .where(
        sql`workspace_id = ${c.workspaceId} AND campaign_id = ${c.id} AND direction = 'outbound' AND created_at >= date_trunc('day', now() AT TIME ZONE COALESCE((SELECT calendar_config->>'timezone' FROM workspaces WHERE id = ${c.workspaceId}), 'America/New_York')) AT TIME ZONE COALESCE((SELECT calendar_config->>'timezone' FROM workspaces WHERE id = ${c.workspaceId}), 'America/New_York')`,
      );
    const sentToday = todayRow?.n ?? 0;
    const budget = Math.max(0, c.dailySendLimit - sentToday);
    if (budget <= 0) continue;

    const cold = await db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.campaignId, c.id),
          eq(leads.lifecycleStatus, 'active'),
          eq(leads.aiOwner, true),
          isNull(leads.nextActionAt),
          eq(leads.emailAttemptCount, 0),
          inArray(leads.status, COLD_STATUSES),
          // Hard exclude test-send leads — they're isolated to the playground
          // view (Step 11) and must never be auto-mailed by the worker. Both
          // names covered for back-compat with pre-2026-05-26 rows.
          sql`(${leads.source} IS NULL OR ${leads.source} NOT IN ('playground', 'playground_test', 'sales_training_test'))`,
          // Soft-deleted leads: operator explicitly killed them; never send.
          sql`${leads.deletedAt} IS NULL`,
          // Known-broken email addresses: previous send failed permanently
          // (bounce/invalid). Don't retry until the operator updates the
          // address — the leads PATCH handler clears this when email changes.
          sql`${leads.emailSendFailedAt} IS NULL`,
        ),
      )
      .limit(budget);
    if (cold.length === 0) continue;

    await db
      .update(leads)
      .set({ nextActionAt: new Date(), updatedAt: new Date() })
      .where(inArray(leads.id, cold.map((l) => l.id)));
    queued += cold.length;
  }
  return queued;
}

/** Pick due leads, run the gate, generate via AI, send via Gmail. */
export async function runFollowups(opts: { workspaceId?: string; limit?: number } = {}): Promise<FollowupRunStats> {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 25, 200);

  // Daily housekeeping + scheduled-start auto-activation + cold-start
  // queueing before the due scan.
  await resetStaleDailyCounts();
  try {
    const sched = await activateScheduledCampaigns();
    if (sched.activated > 0 || sched.failed > 0) {
      log.info({ sched }, 'scheduled campaigns activated');
    }
  } catch (err) {
    log.error({ err }, 'scheduled-activation tick failed');
  }
  const coldQueued = await queueColdStart(opts.workspaceId);

  const conds = [
    eq(leads.lifecycleStatus, 'active'),
    eq(leads.aiOwner, true),
    isNotNull(leads.nextActionAt),
    lte(leads.nextActionAt, new Date()),
    isNotNull(leads.campaignId),
    // Belt-and-suspenders to mirror the queueColdStart filter. Even if a stale
    // test-send lead still has a next_action_at from before the fix, never
    // re-send to it via the worker.
    sql`(${leads.source} IS NULL OR ${leads.source} NOT IN ('playground', 'playground_test', 'sales_training_test'))`,
    // Soft-deleted + email-failed: same exclusion as queueColdStart above.
    sql`${leads.deletedAt} IS NULL`,
    sql`${leads.emailSendFailedAt} IS NULL`,
  ];
  if (opts.workspaceId) conds.push(eq(leads.workspaceId, opts.workspaceId));

  const dueLeads = await db
    .select()
    .from(leads)
    .where(and(...conds))
    .limit(limit);

  const stats: FollowupRunStats = { scanned: dueLeads.length, sent: 0, blocked: 0, errors: 0, coldQueued };

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
  if (!cRow || cRow.status !== 'active') return false;
  // Defence-in-depth: campaign-level warmup is dead code post-2026-05-26 but
  // gate here anyway. A stale row with warmupMode=true means the operator's
  // launch state is ambiguous — refuse to send until they explicitly activate.
  if (cRow.warmupMode) return false;
  // And source guard at the per-lead layer too, so any path that calls runOne
  // outside the dueLeads scan (e.g. direct testing) is still safe.
  if (
    lead.source === 'playground' ||
    lead.source === 'playground_test' ||
    lead.source === 'sales_training_test'
  )
    return false;
  // Soft-deleted: operator pulled the kill switch. Never act.
  if (lead.deletedAt) return false;
  // Email previously failed permanently; wait for operator to fix the
  // address (the leads PATCH handler clears emailSendFailedAt on email
  // change).
  if (lead.emailSendFailedAt) return false;

  // Campaign-level SMS config (with sane defaults if null).
  const smsConfig = {
    channelMode: cRow.smsConfig?.channelMode ?? 'auto',
    quietHoursStart: cRow.smsConfig?.quietHoursStart ?? '20:00',
    quietHoursEnd: cRow.smsConfig?.quietHoursEnd ?? '09:00',
  };

  // Channel-mode enforcement BEFORE the fallback rule.
  if (smsConfig.channelMode === 'email_only' && lead.channel === 'sms') {
    // This campaign forbids SMS — drop the scheduled send.
    await db
      .update(leads)
      .set({ nextActionAt: null, updatedAt: new Date() })
      .where(eq(leads.id, lead.id));
    log.info({ leadId: lead.id, campaignId: cRow.id }, 'sms blocked: campaign channel_mode=email_only');
    return false;
  }
  if (smsConfig.channelMode === 'sms_only' && lead.channel === 'email') {
    if (toE164(lead.phone)) {
      await db
        .update(leads)
        .set({ channel: 'sms', updatedAt: new Date() })
        .where(eq(leads.id, lead.id));
      lead.channel = 'sms';
      log.info({ leadId: lead.id, campaignId: cRow.id }, 'forced to sms: campaign channel_mode=sms_only');
    } else {
      await db
        .update(leads)
        .set({ nextActionAt: null, updatedAt: new Date() })
        .where(eq(leads.id, lead.id));
      log.info({ leadId: lead.id }, 'sms_only campaign but lead has no usable phone');
      return false;
    }
  }

  // Email → SMS fallback: after 2 silent follow-ups (status sent_followup_2),
  // pivot the lead to a short SMS mini-cadence. Reaching this point in runOne
  // implies no reply since FU2 (replies clear next_action_at via the reply
  // pipeline). Eligibility = 'auto' campaign mode, email-channel lead with a
  // usable phone number.
  if (
    smsConfig.channelMode === 'auto' &&
    lead.channel === 'email' &&
    lead.status === 'sent_followup_2' &&
    toE164(lead.phone)
  ) {
    await db
      .update(leads)
      .set({ channel: 'sms', updatedAt: new Date() })
      .where(eq(leads.id, lead.id));
    lead.channel = 'sms';
    log.info({ leadId: lead.id }, 'email→sms fallback after 2 silent follow-ups');
  }

  const channel: 'email' | 'sms' = lead.channel === 'sms' ? 'sms' : 'email';

  // Email leads need a Gmail account (campaign's, or fall back to workspace).
  let gmailAccountId: string | null = null;
  if (channel === 'email') {
    gmailAccountId = cRow.gmailAccountId ?? null;
    if (!gmailAccountId) {
      const acct = (
        await db
          .select({ id: gmailAccounts.id })
          .from(gmailAccounts)
          .where(and(eq(gmailAccounts.workspaceId, lead.workspaceId), eq(gmailAccounts.isActive, true)))
          .orderBy(desc(gmailAccounts.createdAt))
          .limit(1)
      )[0];
      if (!acct) return false;
      gmailAccountId = acct.id;
    }
  }

  const gate = await canSend({
    workspaceId: lead.workspaceId,
    campaignId: lead.campaignId,
    leadId: lead.id,
    channel,
    gmailAccountId: gmailAccountId ?? undefined,
  });
  if (!gate.allowed) {
    // A transient block (daily limit hit / account health) should be retried
    // tomorrow — not dropped. A terminal block (suppression, exit rules, lead
    // closed) clears next_action_at so the lead stops being scanned.
    const transient = /daily send limit|gmail health/i.test(gate.reason ?? '');
    await db
      .update(leads)
      .set({
        nextActionAt: transient ? new Date(Date.now() + 24 * 3_600_000) : null,
        updatedAt: new Date(),
      })
      .where(eq(leads.id, lead.id));
    return false;
  }

  // SMS quiet-hours: never text outside the configured window (workspace tz).
  if (channel === 'sms') {
    const cfg = await getCalendarConfig(lead.workspaceId);
    if (isWithinQuietHours(cfg.timezone, smsConfig.quietHoursStart, smsConfig.quietHoursEnd)) {
      await db
        .update(leads)
        .set({ nextActionAt: new Date(Date.now() + 60 * 60 * 1000), updatedAt: new Date() })
        .where(eq(leads.id, lead.id));
      log.info(
        { leadId: lead.id, tz: cfg.timezone, quiet: `${smsConfig.quietHoursStart}–${smsConfig.quietHoursEnd}` },
        'sms send held by quiet hours — retrying in 1h',
      );
      return false;
    }
  }

  const stage = stageLabel(lead.status as LeadStatus);
  const ai = await generateEmail({
    workspaceId: lead.workspaceId,
    campaignId: lead.campaignId,
    leadId: lead.id,
    stage,
    channel,
  });

  if (channel === 'sms') {
    await sendSmsToLead({
      workspaceId: lead.workspaceId,
      leadId: lead.id,
      body: ai.output.body,
    });
  } else {
    // Continue the existing thread if one exists, else start a new one.
    // On a recipient-specific Gmail failure (invalid address / bounce-like
    // signal), mark the lead's email as failed so the worker stops retrying.
    // Account-level errors (paused/at_risk/daily-limit) come back as
    // ConflictError from gmail.service; those are NOT recipient problems
    // and we rethrow so the run is marked transient.
    try {
      await sendEmail({
        workspaceId: lead.workspaceId,
        gmailAccountId: gmailAccountId!,
        to: lead.email,
        subject: ai.output.subject,
        body: ai.output.body,
        campaignId: lead.campaignId,
        leadId: lead.id,
        threadId: lead.gmailThreadId ?? undefined,
        attachmentFileIds: ai.output.attachment_file_ids,
      });
    } catch (err) {
      if (isRecipientFailure(err)) {
        const reason = describeSendFailure(err);
        await db
          .update(leads)
          .set({
            emailSendFailedAt: new Date(),
            emailSendFailReason: reason,
            // Clear next_action_at so this lead stops looking due. It'll
            // become eligible again only when the operator updates
            // lead.email (handler clears the failure stamp).
            nextActionAt: null,
            updatedAt: new Date(),
          })
          .where(eq(leads.id, lead.id));
        log.warn(
          { leadId: lead.id, email: lead.email, reason },
          'email send marked failed — operator must update address',
        );
      }
      throw err;
    }
  }

  const newStatus = nextStatus(lead.status as LeadStatus);
  const stageKey = newStatus ?? lead.status;
  let daysAhead = NEXT_STAGE_DAYS[stageKey] ?? 0;
  // SMS uses a tighter mini-cadence than email's 0/2/5/8/12 spacing — short
  // and direct, closing fast if there's no response.
  if (channel === 'sms' && daysAhead > 0) {
    const SMS_DAYS: Record<string, number> = {
      sent_email_1: 1,
      sent_followup_1: 2,
      sent_followup_2: 2,
      sent_followup_3: 2,
    };
    daysAhead = SMS_DAYS[stageKey] ?? daysAhead;
  }
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
