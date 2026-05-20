import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/db';
import { campaignGoals, type CampaignGoal, type NewCampaignGoal } from '../db/schema/campaign-goals';
import { campaignExitRules, type CampaignExitRules, type NewCampaignExitRules } from '../db/schema/campaign-exit-rules';
import { campaignPlaybooks, type CampaignPlaybook, type NewCampaignPlaybook } from '../db/schema/campaign-playbooks';
import { campaignDemoGuides, type CampaignDemoGuide, type NewCampaignDemoGuide } from '../db/schema/campaign-demo-guides';
import { NotFoundError } from '../utils/errors';

type Patch<T> = Partial<Omit<T, 'id' | 'workspaceId' | 'campaignId' | 'createdAt'>>;

// -------- GOAL --------

export async function getGoal(workspaceId: string, campaignId: string): Promise<CampaignGoal | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaignGoals)
    .where(and(eq(campaignGoals.workspaceId, workspaceId), eq(campaignGoals.campaignId, campaignId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertGoal(
  workspaceId: string,
  campaignId: string,
  input: Patch<NewCampaignGoal> & { primaryGoal?: string; primaryCta?: string },
): Promise<CampaignGoal> {
  const db = getDb();
  const existing = await getGoal(workspaceId, campaignId);
  if (existing) {
    const rows = await db
      .update(campaignGoals)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(campaignGoals.id, existing.id))
      .returning();
    return rows[0]!;
  }
  if (!input.primaryGoal || !input.primaryCta) {
    throw new NotFoundError('Goal does not exist yet; first create must include primary_goal and primary_cta');
  }
  const rows = await db
    .insert(campaignGoals)
    .values({
      workspaceId,
      campaignId,
      primaryGoal: input.primaryGoal,
      primaryCta: input.primaryCta,
      ...input,
    } as NewCampaignGoal)
    .returning();
  return rows[0]!;
}

// -------- EXIT RULES --------

export async function getExitRules(workspaceId: string, campaignId: string): Promise<CampaignExitRules | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaignExitRules)
    .where(and(eq(campaignExitRules.workspaceId, workspaceId), eq(campaignExitRules.campaignId, campaignId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertExitRules(
  workspaceId: string,
  campaignId: string,
  input: Patch<NewCampaignExitRules>,
): Promise<CampaignExitRules> {
  const db = getDb();
  const existing = await getExitRules(workspaceId, campaignId);
  if (existing) {
    const rows = await db
      .update(campaignExitRules)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(campaignExitRules.id, existing.id))
      .returning();
    return rows[0]!;
  }
  const rows = await db
    .insert(campaignExitRules)
    .values({ workspaceId, campaignId, ...input } as NewCampaignExitRules)
    .returning();
  return rows[0]!;
}

// -------- PLAYBOOK --------

export async function getPlaybook(workspaceId: string, campaignId: string): Promise<CampaignPlaybook | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaignPlaybooks)
    .where(and(eq(campaignPlaybooks.workspaceId, workspaceId), eq(campaignPlaybooks.campaignId, campaignId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertPlaybook(
  workspaceId: string,
  campaignId: string,
  input: Patch<NewCampaignPlaybook>,
): Promise<CampaignPlaybook> {
  const db = getDb();
  const existing = await getPlaybook(workspaceId, campaignId);
  if (existing) {
    // Editing an approved playbook drops it back to draft; user must re-approve.
    const nextApproval = existing.approvalStatus === 'approved' ? 'draft' : existing.approvalStatus;
    const rows = await db
      .update(campaignPlaybooks)
      .set({ ...input, approvalStatus: nextApproval, updatedAt: new Date() })
      .where(eq(campaignPlaybooks.id, existing.id))
      .returning();
    return rows[0]!;
  }
  const rows = await db
    .insert(campaignPlaybooks)
    .values({ workspaceId, campaignId, ...input } as NewCampaignPlaybook)
    .returning();
  return rows[0]!;
}

export async function approvePlaybook(workspaceId: string, campaignId: string): Promise<CampaignPlaybook> {
  const db = getDb();
  const existing = await getPlaybook(workspaceId, campaignId);
  if (!existing) throw new NotFoundError('Playbook not found');
  const rows = await db
    .update(campaignPlaybooks)
    .set({ approvalStatus: 'approved', approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(campaignPlaybooks.id, existing.id))
    .returning();
  return rows[0]!;
}

// -------- DEMO GUIDE --------

export async function getDemoGuide(workspaceId: string, campaignId: string): Promise<CampaignDemoGuide | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaignDemoGuides)
    .where(and(eq(campaignDemoGuides.workspaceId, workspaceId), eq(campaignDemoGuides.campaignId, campaignId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertDemoGuide(
  workspaceId: string,
  campaignId: string,
  input: Patch<NewCampaignDemoGuide>,
): Promise<CampaignDemoGuide> {
  const db = getDb();
  const existing = await getDemoGuide(workspaceId, campaignId);
  if (existing) {
    const nextApproval = existing.approvalStatus === 'approved' ? 'draft' : existing.approvalStatus;
    const rows = await db
      .update(campaignDemoGuides)
      .set({ ...input, approvalStatus: nextApproval, updatedAt: new Date() })
      .where(eq(campaignDemoGuides.id, existing.id))
      .returning();
    return rows[0]!;
  }
  const rows = await db
    .insert(campaignDemoGuides)
    .values({ workspaceId, campaignId, ...input } as NewCampaignDemoGuide)
    .returning();
  return rows[0]!;
}

export async function approveDemoGuide(workspaceId: string, campaignId: string): Promise<CampaignDemoGuide> {
  const db = getDb();
  const existing = await getDemoGuide(workspaceId, campaignId);
  if (!existing) throw new NotFoundError('Demo guide not found');
  const rows = await db
    .update(campaignDemoGuides)
    .set({ approvalStatus: 'approved', approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(campaignDemoGuides.id, existing.id))
    .returning();
  return rows[0]!;
}
