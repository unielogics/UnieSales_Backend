import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { workspaces, type NewWorkspace, type Workspace } from '../db/schema/workspaces';
import { workspaceMembers, type WorkspaceRole } from '../db/schema/workspace-members';
import { campaigns } from '../db/schema/campaigns';
import { leads } from '../db/schema/leads';
import { gmailAccounts } from '../db/schema/gmail-accounts';
import { aiActions } from '../db/schema/ai-actions';
import { NotFoundError } from '../utils/errors';

export interface WorkspaceWithRole extends Workspace {
  role: WorkspaceRole;
}

/** List every workspace the user is a member of, with their role on each. */
export async function listForUser(userId: string): Promise<WorkspaceWithRole[]> {
  const db = getDb();
  const rows = await db
    .select({
      workspace: workspaces,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));
  return rows.map((r) => ({ ...r.workspace, role: r.role as WorkspaceRole }));
}

export async function getById(workspaceId: string): Promise<Workspace | null> {
  const db = getDb();
  const rows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return rows[0] ?? null;
}

/** Create a workspace and add the caller as owner in one transaction. */
export async function create(input: Omit<NewWorkspace, 'id' | 'createdAt' | 'updatedAt'>, ownerUserId: string): Promise<Workspace> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [ws] = await tx.insert(workspaces).values(input).returning();
    if (!ws) throw new Error('failed to insert workspace');
    await tx.insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: ownerUserId,
      role: 'owner',
    });
    return ws;
  });
}

export async function update(
  workspaceId: string,
  patch: Partial<Omit<NewWorkspace, 'id' | 'createdAt'>>,
): Promise<Workspace> {
  const db = getDb();
  const rows = await db
    .update(workspaces)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId))
    .returning();
  const ws = rows[0];
  if (!ws) throw new NotFoundError('Workspace not found');
  return ws;
}

export interface DashboardSummary {
  workspace: Workspace;
  counts: {
    campaigns: { total: number; active: number; draft: number };
    leads: { total: number; active: number; closed: number };
    gmail_accounts: number;
    pending_ai_actions: number;
    send_volume_7d: number;
    handoff_queue: number;
    replied_7d: number;
  };
}

/** Aggregate counts for the workspace overview dashboard. */
export async function dashboard(workspaceId: string): Promise<DashboardSummary> {
  const db = getDb();

  const ws = await getById(workspaceId);
  if (!ws) throw new NotFoundError('Workspace not found');

  const [campaignsStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`sum(case when ${campaigns.status} = 'active' then 1 else 0 end)::int`,
      draft: sql<number>`sum(case when ${campaigns.status} = 'draft' then 1 else 0 end)::int`,
    })
    .from(campaigns)
    .where(eq(campaigns.workspaceId, workspaceId));

  const [leadsStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`sum(case when ${leads.lifecycleStatus} = 'active' then 1 else 0 end)::int`,
      closed: sql<number>`sum(case when ${leads.lifecycleStatus} = 'closed' then 1 else 0 end)::int`,
    })
    .from(leads)
    .where(eq(leads.workspaceId, workspaceId));

  const [gmailCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(gmailAccounts)
    .where(eq(gmailAccounts.workspaceId, workspaceId));

  const [aiPending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiActions)
    .where(and(eq(aiActions.workspaceId, workspaceId), inArray(aiActions.status, ['pending', 'processing'])));

  // Send volume in last 7 days + handoff queue depth + recent thread activity
  const [sendVolume] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sql`email_messages`)
    .where(
      sql`workspace_id = ${workspaceId} AND direction = 'outbound' AND created_at >= NOW() - INTERVAL '7 days'`,
    );
  const [handoffQueue] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.status, 'handoff_required')));
  const [repliedThisWeek] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(sql`workspace_id = ${workspaceId} AND status = 'replied' AND updated_at >= NOW() - INTERVAL '7 days'`);

  return {
    workspace: ws,
    counts: {
      campaigns: {
        total: campaignsStats?.total ?? 0,
        active: campaignsStats?.active ?? 0,
        draft: campaignsStats?.draft ?? 0,
      },
      leads: {
        total: leadsStats?.total ?? 0,
        active: leadsStats?.active ?? 0,
        closed: leadsStats?.closed ?? 0,
      },
      gmail_accounts: gmailCount?.n ?? 0,
      pending_ai_actions: aiPending?.n ?? 0,
      send_volume_7d: sendVolume?.n ?? 0,
      handoff_queue: handoffQueue?.n ?? 0,
      replied_7d: repliedThisWeek?.n ?? 0,
    },
  };
}
