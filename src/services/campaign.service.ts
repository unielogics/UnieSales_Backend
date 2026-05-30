import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { campaigns, CAMPAIGN_STATUSES, type Campaign, type CampaignStatus, type NewCampaign } from '../db/schema/campaigns';
import { gmailAccounts } from '../db/schema/gmail-accounts';
import { emailMessages } from '../db/schema/email-messages';
import { leads } from '../db/schema/leads';
import { workspaces } from '../db/schema/workspaces';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { canActivate, type ActivationResult } from './activation.service';

/** A campaign plus how many outbound emails it has sent so far today. */
export type CampaignWithUsage = Campaign & { sentToday: number };

export async function list(workspaceId: string): Promise<CampaignWithUsage[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.workspaceId, workspaceId))
    .orderBy(desc(campaigns.createdAt));
  if (rows.length === 0) return [];

  // "Today" follows the operator's calendar timezone so "remaining today"
  // rolls over at their midnight, not UTC midnight.
  const wsRows = await db
    .select({ cfg: workspaces.calendarConfig })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const tz = wsRows[0]?.cfg?.timezone ?? 'America/New_York';

  // Outbound emails sent today, per campaign — drives "remaining today".
  const sentRows = await db
    .select({ campaignId: emailMessages.campaignId, n: sql<number>`count(*)::int` })
    .from(emailMessages)
    .where(
      sql`workspace_id = ${workspaceId} AND direction = 'outbound' AND created_at >= date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}`,
    )
    .groupBy(emailMessages.campaignId);
  const sentMap = new Map(sentRows.map((r) => [r.campaignId, r.n]));

  return rows.map((c) => ({ ...c, sentToday: sentMap.get(c.id) ?? 0 }));
}

export async function getById(workspaceId: string, campaignId: string): Promise<Campaign | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.id, campaignId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getByIdOrThrow(workspaceId: string, campaignId: string): Promise<Campaign> {
  const c = await getById(workspaceId, campaignId);
  if (!c) throw new NotFoundError('Campaign not found');
  return c;
}

export async function create(
  workspaceId: string,
  input: Omit<NewCampaign, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
): Promise<Campaign> {
  const db = getDb();
  const rows = await db
    .insert(campaigns)
    .values({ ...input, workspaceId })
    .returning();
  if (!rows[0]) throw new Error('failed to insert campaign');
  return rows[0];
}

export async function update(
  workspaceId: string,
  campaignId: string,
  patch: Partial<Omit<NewCampaign, 'id' | 'workspaceId' | 'createdAt'>>,
): Promise<Campaign> {
  const db = getDb();
  await getByIdOrThrow(workspaceId, campaignId); // existence + workspace check
  const rows = await db
    .update(campaigns)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.id, campaignId)))
    .returning();
  return rows[0]!;
}

async function transition(
  workspaceId: string,
  campaignId: string,
  next: CampaignStatus,
  allowedFrom: CampaignStatus[],
): Promise<Campaign> {
  const db = getDb();
  const c = await getByIdOrThrow(workspaceId, campaignId);
  if (!allowedFrom.includes(c.status as CampaignStatus)) {
    throw new ConflictError(
      `Cannot transition from '${c.status}' to '${next}'`,
      [{ field: 'status', reason: `current status '${c.status}' does not allow this action` }],
    );
  }
  const rows = await db
    .update(campaigns)
    .set({ status: next, updatedAt: new Date() })
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.id, campaignId)))
    .returning();
  return rows[0]!;
}

/**
 * Activate a campaign. Two paths:
 *  - Campaign already live in warm-up (status=active, warmup_mode=true):
 *    just graduate it out of warm-up — no gate re-run.
 *  - Otherwise: run the 12-check gate, transition to active, warm-up off.
 */
/** The workspace's most-recent active Gmail account, if any. */
async function resolveWorkspaceGmailAccountId(workspaceId: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ id: gmailAccounts.id })
    .from(gmailAccounts)
    .where(and(eq(gmailAccounts.workspaceId, workspaceId), eq(gmailAccounts.isActive, true)))
    .orderBy(desc(gmailAccounts.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function activate(workspaceId: string, campaignId: string): Promise<{ campaign: Campaign; activation: ActivationResult }> {
  let c = await getByIdOrThrow(workspaceId, campaignId);

  // An active campaign with no Gmail account assigned is inert — the followup
  // worker skips every lead (`!campaign.gmailAccountId`). Auto-assign the
  // workspace's active account so the campaign actually sends once live, and
  // so the activation gate's Gmail check passes.
  if (!c.gmailAccountId) {
    const gmailAccountId = await resolveWorkspaceGmailAccountId(workspaceId);
    if (gmailAccountId) c = await update(workspaceId, campaignId, { gmailAccountId });
  }

  if (c.status === 'active') {
    // Graduating out of warm-up (or a no-op if already fully active).
    const updated = c.warmupMode
      ? await update(workspaceId, campaignId, { warmupMode: false })
      : c;
    return { campaign: updated, activation: { allowed: true, blockers: [] } };
  }

  const activation = await canActivate(workspaceId, c);
  if (!activation.allowed) {
    throw new ConflictError('Campaign cannot be activated yet', activation.blockers);
  }
  await transition(workspaceId, campaignId, 'active', [
    'draft',
    'needs_training',
    'training_in_progress',
    'needs_review',
    'ready_to_activate',
    'paused',
  ]);
  // Full activation always clears warm-up.
  const updated = await update(workspaceId, campaignId, { warmupMode: false });
  return { campaign: updated, activation };
}

/**
 * Emergency brake. Always allowed unless the campaign is `archived` (terminal).
 * Idempotent: pausing an already-paused campaign is a 200 no-op.
 *
 * Side effect: null out every `next_action_at` on this campaign's leads, so
 * the followup worker physically can't fire even if it just selected rows
 * before our status update committed.
 *
 * Replaces the old `transition(..., ['active'])` form, which returned 409 from
 * any non-active state and stranded operators with no way to stop a misbehaving
 * campaign in `draft`/`ready_to_activate`/etc.
 */
export async function pause(workspaceId: string, campaignId: string): Promise<Campaign> {
  const db = getDb();
  const c = await getByIdOrThrow(workspaceId, campaignId);
  if (c.status === 'archived') {
    throw new ConflictError('Cannot pause an archived campaign', [
      { field: 'status', reason: 'campaign is archived' },
    ]);
  }
  // Always dequeue, even on the idempotent path — a stuck `next_action_at`
  // from a previous bug should clear on every pause click.
  await db
    .update(leads)
    .set({ nextActionAt: null, updatedAt: new Date() })
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.campaignId, campaignId)));
  if (c.status === 'paused') return c; // idempotent
  const rows = await db
    .update(campaigns)
    .set({ status: 'paused', updatedAt: new Date() })
    .where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.id, campaignId)))
    .returning();
  return rows[0]!;
}

/**
 * Worker-side hook: fire the activation gate for every campaign whose
 * `scheduled_start_at` has come up. Each successful activation clears the
 * stamp so we don't re-fire on the next tick. Gate failures leave the
 * scheduled time in place — the worker retries until the operator resolves
 * the blockers or the schedule is changed.
 */
export async function activateScheduledCampaigns(): Promise<{
  activated: number;
  failed: number;
}> {
  const db = getDb();
  const due = await db
    .select()
    .from(campaigns)
    .where(
      sql`scheduled_start_at IS NOT NULL AND scheduled_start_at <= NOW() AND status NOT IN ('active','archived')`,
    );
  let activated = 0;
  let failed = 0;
  for (const c of due) {
    try {
      await activate(c.workspaceId, c.id);
      await db
        .update(campaigns)
        .set({ scheduledStartAt: null, updatedAt: new Date() })
        .where(eq(campaigns.id, c.id));
      activated++;
    } catch {
      failed++;
    }
  }
  return { activated, failed };
}

export async function archive(workspaceId: string, campaignId: string): Promise<Campaign> {
  return transition(workspaceId, campaignId, 'archived', [
    'draft',
    'needs_training',
    'training_in_progress',
    'needs_review',
    'ready_to_activate',
    'active',
    'paused',
  ]);
}

export function isValidStatus(s: unknown): s is CampaignStatus {
  return typeof s === 'string' && (CAMPAIGN_STATUSES as readonly string[]).includes(s);
}

export function validateStatusOrThrow(s: string): CampaignStatus {
  if (!isValidStatus(s)) {
    throw new ValidationError('Invalid status', [{ field: 'status', reason: `must be one of ${CAMPAIGN_STATUSES.join(', ')}` }]);
  }
  return s;
}
