import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../config/db';
import { campaigns, CAMPAIGN_STATUSES, type Campaign, type CampaignStatus, type NewCampaign } from '../db/schema/campaigns';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { canActivate, type ActivationResult } from './activation.service';

export async function list(workspaceId: string): Promise<Campaign[]> {
  const db = getDb();
  return db.select().from(campaigns).where(eq(campaigns.workspaceId, workspaceId)).orderBy(desc(campaigns.createdAt));
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

/** Activate: run the 12-check gate first. */
export async function activate(workspaceId: string, campaignId: string): Promise<{ campaign: Campaign; activation: ActivationResult }> {
  const c = await getByIdOrThrow(workspaceId, campaignId);
  const activation = await canActivate(workspaceId, c);
  if (!activation.allowed) {
    throw new ConflictError('Campaign cannot be activated yet', activation.blockers);
  }
  const updated = await transition(workspaceId, campaignId, 'active', [
    'draft',
    'needs_training',
    'training_in_progress',
    'needs_review',
    'ready_to_activate',
    'paused',
  ]);
  return { campaign: updated, activation };
}

export async function pause(workspaceId: string, campaignId: string): Promise<Campaign> {
  return transition(workspaceId, campaignId, 'paused', ['active']);
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
