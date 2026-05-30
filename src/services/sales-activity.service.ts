/**
 * sales-activities service — append-only audit-trail writer.
 *
 * Layer 2 surfaces (notes service, tasks service, post-intake runner,
 * pipeline transitions, booking events) all funnel through `emit()` so the
 * Activity tab on a lead is the single source of truth for "what happened,
 * when". Never UPDATE or DELETE from this table; new rows only.
 */
import { and, eq, desc, lt, isNull, ne, or, inArray, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import {
  salesActivities,
  type SalesActivity,
  type NewSalesActivity,
  type SalesActivityType,
} from '../db/schema/sales-activities';
import { leads } from '../db/schema/leads';

export interface EmitInput {
  workspaceId: string;
  leadId?: string | null;
  campaignId?: string | null;
  activityType: SalesActivityType;
  title?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
  /** 'system' | 'ai' | <user_id>. Defaults to 'system'. */
  createdBy?: string;
}

export async function emit(input: EmitInput): Promise<SalesActivity> {
  const db = getDb();
  const row: NewSalesActivity = {
    workspaceId: input.workspaceId,
    leadId: input.leadId ?? null,
    campaignId: input.campaignId ?? null,
    activityType: input.activityType,
    title: input.title ?? null,
    description: input.description ?? null,
    // jsonb default `'{}'::jsonb` covers null; we coerce for clarity.
    metadata: (input.metadata ?? {}) as Record<string, unknown>,
    createdBy: input.createdBy ?? 'system',
  };
  const [inserted] = await db.insert(salesActivities).values(row).returning();
  if (!inserted) throw new Error('emit: insert returned no row');
  return inserted;
}

export interface ListForLeadOpts {
  limit?: number;
  /** ISO timestamp; returns rows strictly older than this (for paging). */
  before?: string;
}

/** Lead timeline — newest first. Used by the lead modal Activity tab. */
export async function listForLead(
  workspaceId: string,
  leadId: string,
  opts: ListForLeadOpts = {},
): Promise<SalesActivity[]> {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conds = [
    eq(salesActivities.workspaceId, workspaceId),
    eq(salesActivities.leadId, leadId),
  ];
  if (opts.before) conds.push(lt(salesActivities.createdAt, new Date(opts.before)));
  return db
    .select()
    .from(salesActivities)
    .where(and(...conds))
    .orderBy(desc(salesActivities.createdAt))
    .limit(limit);
}

export interface ListForWorkspaceOpts {
  limit?: number;
  before?: string;
  activityType?: SalesActivityType;
  /**
   * Sales/Campaigns isolation. Filters via the linked lead's import_origin
   * — activities without a linked lead are treated as outbound (legacy
   * default). Sales mode passes 'intake' so only intake-origin activities
   * surface in the Sales Cockpit feed.
   */
  origin?: 'intake' | 'outbound';
}

/** Workspace-wide feed — Notes screen, audit dashboards. */
export async function listForWorkspace(
  workspaceId: string,
  opts: ListForWorkspaceOpts = {},
): Promise<SalesActivity[]> {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conds = [eq(salesActivities.workspaceId, workspaceId)];
  if (opts.activityType) conds.push(eq(salesActivities.activityType, opts.activityType));
  if (opts.before) conds.push(lt(salesActivities.createdAt, new Date(opts.before)));
  if (opts.origin === 'intake') {
    const intakeLeads = db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.workspaceId, workspaceId), eq(leads.importOrigin, 'intake')));
    conds.push(inArray(salesActivities.leadId, intakeLeads));
  } else if (opts.origin === 'outbound') {
    const outboundLeads = db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.workspaceId, workspaceId),
          or(isNull(leads.importOrigin), ne(leads.importOrigin, 'intake'))!,
        ),
      );
    conds.push(
      or(isNull(salesActivities.leadId), inArray(salesActivities.leadId, outboundLeads))!,
    );
  }
  return db
    .select()
    .from(salesActivities)
    .where(and(...conds))
    .orderBy(desc(salesActivities.createdAt))
    .limit(limit);
}

/** Counts by activity_type — for the AI Status strip on the Cockpit. */
export async function countByTypeToday(workspaceId: string): Promise<Record<string, number>> {
  const db = getDb();
  const rows = await db
    .select({
      kind: salesActivities.activityType,
      n: sql<number>`count(*)::int`,
    })
    .from(salesActivities)
    .where(
      and(
        eq(salesActivities.workspaceId, workspaceId),
        sql`${salesActivities.createdAt} >= (now() - interval '24 hours')`,
      ),
    )
    .groupBy(salesActivities.activityType);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = r.n;
  return out;
}
