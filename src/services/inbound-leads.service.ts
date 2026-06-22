/**
 * Inbound-leads service — filtered view over the leads table for the
 * dedicated Inbound Leads frontend page. Pure read service: it doesn't
 * mutate, it just composes a where clause from the URL filters.
 *
 * "Inbound" is defined as leads whose `source` starts with one of the
 * known site prefixes (uniewms_, unielogics_, uniecortex_). This matches
 * the source string the intake service stamps at insert time.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { leads, type Lead } from '../db/schema/leads';
import { INTAKE_SITES, SITE_TAGS, type IntakeSite } from '../config/intake-routing';
import { salesTasks } from '../db/schema/sales-tasks';
import { handoffs } from '../db/schema/handoffs';

export interface InboundLeadsFilters {
  site?: IntakeSite;
  tag?: string;
  /**
   * Coarse-grained filter the UI exposes as a chip row. Maps to specific
   * pipeline_stage / status / has-handoff combinations.
   */
  filter?:
    | 'all'
    | 'needs_review'   // pipeline_stage = 'ai_reviewed', 'new_inbound', or 'new_catalog_audit'
    | 'booking_ready'  // status in (interested, info_sent) — heuristic
    | 'handoff_required'
    | 'closed';        // lifecycle_status = 'closed'
  limit?: number;
  offset?: number;
  /** When true, include leads with source='sales_training_test' alongside
   *  real inbound leads. Default false — operator's pre-launch test traffic
   *  shouldn't crowd the production view. */
  includeTests?: boolean;
}

export interface InboundLeadRow {
  id: string;
  workspaceId: string;
  campaignId: string | null;
  email: string;
  contactName: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  title: string | null;
  phone: string | null;
  source: string | null;
  sourceUrl: string | null;
  site: IntakeSite | null;
  tag: string | null;
  leadScore: number;
  status: string;
  pipelineStage: string | null;
  nextActionAt: string | null;
  hasOpenHandoff: boolean;
  openTaskCount: number;
  createdAt: string;
  postIntakeProcessedAt: string | null;
}

export interface InboundLeadsResult {
  items: InboundLeadRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * The 9 known source slugs the intake service stamps (also = the seeded
 * campaign names for inbound campaigns).
 */
function knownSources(): string[] {
  const out: string[] = [];
  for (const site of INTAKE_SITES) {
    for (const tag of SITE_TAGS[site]) {
      out.push(`${site}_${tag}`);
    }
  }
  out.push('booking_page');
  return out;
}

function deriveSiteAndTag(source: string | null): { site: IntakeSite | null; tag: string | null } {
  if (!source) return { site: null, tag: null };
  for (const site of INTAKE_SITES) {
    if (source.startsWith(`${site}_`)) {
      return { site, tag: source.slice(site.length + 1) };
    }
  }
  return { site: null, tag: null };
}

export async function list(
  workspaceId: string,
  f: InboundLeadsFilters,
): Promise<InboundLeadsResult> {
  const db = getDb();
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);

  // ---- WHERE clause ------------------------------------------------------
  // Sales-mode view includes real public intake leads and manually enrolled
  // Sales leads. Manual Sales leads only appear in the broad view, not in
  // site/tag-specific form filters.
  const conds = [
    eq(leads.workspaceId, workspaceId),
    inArray(leads.importOrigin, ['intake', 'sales_manual']),
    // Soft-delete filter — deleted leads are invisible to the operator
    // and to every AI worker.
    sql`${leads.deletedAt} IS NULL`,
  ];

  // Restrict to inbound sources. If a site filter is supplied, narrow further;
  // if a tag is also supplied, narrow to that single source string.
  //
  // When includeTests=true we ALSO include source='sales_training_test' so
  // the operator can inspect pre-launch test runs side-by-side with real
  // inbound. The filter is opt-in (default false) so test traffic stays out
  // of the production view by default.
  const TEST_SOURCE = 'sales_training_test';
  if (f.site && f.tag) {
    const sources = [`${f.site}_${f.tag}`];
    if (f.includeTests) sources.push(TEST_SOURCE);
    conds.push(inArray(leads.source, sources));
    conds.push(eq(leads.importOrigin, 'intake'));
  } else if (f.site) {
    const tags = SITE_TAGS[f.site] as readonly string[];
    const sources = tags.map((t) => `${f.site}_${t}`);
    if (f.includeTests) sources.push(TEST_SOURCE);
    conds.push(inArray(leads.source, sources));
    conds.push(eq(leads.importOrigin, 'intake'));
  } else {
    const sources = [...knownSources(), 'manual_sales'];
    if (f.includeTests) sources.push(TEST_SOURCE);
    conds.push(inArray(leads.source, sources));
  }

  if (f.filter === 'needs_review') {
    conds.push(
      sql`(${leads.pipelineStage} IS NULL OR ${leads.pipelineStage} IN ('new_inbound', 'ai_reviewed', 'new_catalog_audit'))`,
    );
  } else if (f.filter === 'booking_ready') {
    conds.push(inArray(leads.status, ['interested', 'info_sent', 'meeting_requested']));
  } else if (f.filter === 'handoff_required') {
    conds.push(eq(leads.status, 'handoff_required'));
  } else if (f.filter === 'closed') {
    conds.push(eq(leads.lifecycleStatus, 'closed'));
  }
  // 'all' — no extra condition

  const where = and(...conds);

  // ---- Main page ---------------------------------------------------------
  const rows = await db
    .select()
    .from(leads)
    .where(where)
    .orderBy(desc(leads.createdAt))
    .limit(limit)
    .offset(offset);

  const totalRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(where);
  const total = totalRow[0]?.n ?? 0;

  if (rows.length === 0) {
    return { items: [], total, limit, offset };
  }

  const leadIds = rows.map((r) => r.id);

  // ---- Open-handoff lookup (one query, joined client-side) ---------------
  const handoffRows = await db
    .select({ leadId: handoffs.leadId, status: handoffs.status })
    .from(handoffs)
    .where(
      and(
        eq(handoffs.workspaceId, workspaceId),
        inArray(handoffs.leadId, leadIds),
        inArray(handoffs.status, ['open', 'in_progress']),
      ),
    );
  const openHandoffByLead = new Set<string>();
  for (const h of handoffRows) {
    if (h.leadId) openHandoffByLead.add(h.leadId);
  }

  // ---- Open-task counts --------------------------------------------------
  const taskRows = await db
    .select({
      leadId: salesTasks.leadId,
      n: sql<number>`count(*)::int`,
    })
    .from(salesTasks)
    .where(
      and(
        eq(salesTasks.workspaceId, workspaceId),
        inArray(salesTasks.leadId, leadIds),
        eq(salesTasks.status, 'open'),
      ),
    )
    .groupBy(salesTasks.leadId);
  const openTasksByLead = new Map<string, number>();
  for (const t of taskRows) {
    if (t.leadId) openTasksByLead.set(t.leadId, t.n);
  }

  // ---- Compose ----------------------------------------------------------
  const items: InboundLeadRow[] = rows.map((l: Lead) => {
    const { site, tag } = deriveSiteAndTag(l.source);
    return {
      id: l.id,
      workspaceId: l.workspaceId,
      campaignId: l.campaignId,
      email: l.email,
      contactName: l.contactName,
      firstName: l.firstName,
      lastName: l.lastName,
      companyName: l.companyName,
      title: l.title,
      phone: l.phone,
      source: l.source,
      sourceUrl: l.sourceUrl,
      site,
      tag,
      leadScore: l.leadScore,
      status: l.status,
      pipelineStage: l.pipelineStage,
      nextActionAt: l.nextActionAt ? l.nextActionAt.toISOString() : null,
      hasOpenHandoff: openHandoffByLead.has(l.id),
      openTaskCount: openTasksByLead.get(l.id) ?? 0,
      createdAt: l.createdAt.toISOString(),
      postIntakeProcessedAt: l.postIntakeProcessedAt ? l.postIntakeProcessedAt.toISOString() : null,
    };
  });

  return { items, total, limit, offset };
}

/**
 * Counts per (site, tag) for the chips/sidebar on the Inbound Leads page.
 * Lightweight aggregation — one row per source.
 */
export async function counts(workspaceId: string): Promise<Array<{ site: IntakeSite; tag: string; count: number }>> {
  const db = getDb();
  const rows = await db
    .select({
      source: leads.source,
      n: sql<number>`count(*)::int`,
    })
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, workspaceId),
        inArray(leads.source, knownSources()),
        sql`${leads.deletedAt} IS NULL`,
      ),
    )
    .groupBy(leads.source);
  const out: Array<{ site: IntakeSite; tag: string; count: number }> = [];
  for (const r of rows) {
    const { site, tag } = deriveSiteAndTag(r.source);
    if (site && tag) out.push({ site, tag, count: r.n });
  }
  return out;
}
