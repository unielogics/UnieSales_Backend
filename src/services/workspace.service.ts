import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import {
  workspaces,
  type HandoffRule,
  type NewWorkspace,
  type Workspace,
} from '../db/schema/workspaces';
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

/**
 * Default handoff rules seeded on workspace creation. Users can delete or
 * customise these via Settings → Handoff rules; the column is just a JSONB.
 */
const DEFAULT_HANDOFF_RULES: HandoffRule[] = [
  { id: 'hr-pricing', text: 'Pricing question asked specifically', enabled: true, isDefault: true, tone: 'warning' },
  { id: 'hr-contract', text: 'Custom contract / SOW requested', enabled: true, isDefault: true, tone: 'warning' },
  { id: 'hr-rates', text: 'Loan terms or rates requested', enabled: true, isDefault: true, tone: 'warning' },
  { id: 'hr-sentiment', text: 'Sentiment turns hostile', enabled: true, isDefault: true, tone: 'danger' },
  { id: 'hr-low-conf', text: 'AI confidence drops below 70%', enabled: true, isDefault: true, tone: 'info' },
  { id: 'hr-competitor', text: 'Competitor named without counter', enabled: true, isDefault: true, tone: 'info' },
  { id: 'hr-enterprise', text: 'Enterprise (1000+ employees) inbound', enabled: true, isDefault: true, tone: 'info' },
];

/** Create a workspace and add the caller as owner in one transaction. */
export async function create(input: Omit<NewWorkspace, 'id' | 'createdAt' | 'updatedAt'>, ownerUserId: string): Promise<Workspace> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [ws] = await tx
      .insert(workspaces)
      .values({
        // Seed default handoff rules unless the caller already provided some
        handoffRules: input.handoffRules ?? DEFAULT_HANDOFF_RULES,
        ...input,
      })
      .returning();
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
    /** Leads with a scheduled send the followup worker will fire. */
    scheduled_sends: number;
    send_volume_7d: number;
    send_volume_today: number;
    handoff_queue: number;
    replied_7d: number;
    /** Leads created today, split by how they entered. */
    new_leads_today: { from_upload: number; from_update: number };
  };
}

/** Aggregate counts for the workspace overview dashboard. */
export async function dashboard(workspaceId: string): Promise<DashboardSummary> {
  const db = getDb();

  const ws = await getById(workspaceId);
  if (!ws) throw new NotFoundError('Workspace not found');

  // "Today" follows the operator's calendar timezone, not UTC — so the
  // dashboard's daily numbers roll over at the operator's midnight.
  const tz = ws.calendarConfig?.timezone ?? 'America/New_York';
  const dayStart = sql`date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}`;

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

  // Campaigns Overview is the Campaigns-mode landing — restrict "things to do"
  // counts to outbound-origin leads only. Intake-origin (Sales) leads surface
  // in the Sales Cockpit / Inbound Leads / Sales Tasks instead.
  const outboundLeadIds = db
    .select({ id: leads.id })
    .from(leads)
    .where(
      sql`workspace_id = ${workspaceId} AND (import_origin IS NULL OR import_origin NOT IN ('intake', 'sales_manual'))`,
    );

  const [aiPending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiActions)
    .where(
      and(
        eq(aiActions.workspaceId, workspaceId),
        inArray(aiActions.status, ['pending', 'processing']),
        // Either no linked lead OR the linked lead is outbound.
        sql`(${aiActions.leadId} IS NULL OR ${aiActions.leadId} IN ${outboundLeadIds})`,
      ),
    );

  // Leads with a scheduled send queued for the followup worker. Outbound only.
  const [scheduledSends] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(
      sql`workspace_id = ${workspaceId} AND lifecycle_status = 'active' AND ai_owner = true AND next_action_at IS NOT NULL AND (import_origin IS NULL OR import_origin NOT IN ('intake', 'sales_manual'))`,
    );

  // Send volume in last 7 days + handoff queue depth + recent thread activity
  const [sendVolume] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sql`email_messages`)
    .where(
      sql`workspace_id = ${workspaceId} AND direction = 'outbound' AND created_at >= NOW() - INTERVAL '7 days'`,
    );
  const [sendVolumeToday] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sql`email_messages`)
    .where(
      sql`workspace_id = ${workspaceId} AND direction = 'outbound' AND created_at >= ${dayStart}`,
    );
  // Handoff queue — outbound only on the Campaigns Overview.
  const [handoffQueue] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, workspaceId),
        eq(leads.status, 'handoff_required'),
        sql`(${leads.importOrigin} IS NULL OR ${leads.importOrigin} NOT IN ('intake', 'sales_manual'))`,
      ),
    );
  // Real replies: distinct outbound leads that sent an inbound message in the
  // last 7 days. (Lead status alone undercounts — the reply pipeline
  // immediately advances a replied lead to objection / interested /
  // meeting_requested.)
  const [repliedThisWeek] = await db
    .select({ n: sql<number>`count(distinct em.lead_id)::int` })
    .from(sql`email_messages em JOIN leads l ON l.id = em.lead_id`)
    .where(
      sql`em.workspace_id = ${workspaceId} AND em.direction = 'inbound' AND em.lead_id IS NOT NULL AND em.created_at >= NOW() - INTERVAL '7 days' AND (l.import_origin IS NULL OR l.import_origin NOT IN ('intake', 'sales_manual'))`,
    );

  // New leads created today, split by how they entered (upload vs refresh).
  const [newLeadsToday] = await db
    .select({
      from_upload: sql<number>`sum(case when ${leads.importOrigin} = 'upload' then 1 else 0 end)::int`,
      from_update: sql<number>`sum(case when ${leads.importOrigin} = 'update' then 1 else 0 end)::int`,
    })
    .from(leads)
    .where(sql`workspace_id = ${workspaceId} AND created_at >= ${dayStart}`);

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
      scheduled_sends: scheduledSends?.n ?? 0,
      send_volume_7d: sendVolume?.n ?? 0,
      send_volume_today: sendVolumeToday?.n ?? 0,
      handoff_queue: handoffQueue?.n ?? 0,
      replied_7d: repliedThisWeek?.n ?? 0,
      new_leads_today: {
        from_upload: newLeadsToday?.from_upload ?? 0,
        from_update: newLeadsToday?.from_update ?? 0,
      },
    },
  };
}
