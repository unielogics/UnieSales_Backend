/**
 * sales-tasks service — queued work for the human operator.
 *
 * Creation mirrors the notes service: every task insert writes a paired
 * `task_created` activity row. `complete()` and `snooze()` are state
 * transitions, so they also emit activity entries so the timeline shows
 * "AI created task → operator completed task" naturally.
 */
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import {
  salesTasks,
  type SalesTask,
  type NewSalesTask,
  type SalesTaskType,
  type SalesTaskPriority,
  type SalesTaskStatus,
} from '../db/schema/sales-tasks';
import { leads } from '../db/schema/leads';
import * as activity from './sales-activity.service';

export interface CreateTaskInput {
  workspaceId: string;
  leadId?: string | null;
  title: string;
  type: SalesTaskType;
  priority?: SalesTaskPriority;
  status?: SalesTaskStatus;
  dueAt?: Date | string | null;
  source?: 'manual' | 'AI';
  ownerUserId?: string | null;
}

export async function create(input: CreateTaskInput): Promise<SalesTask> {
  const db = getDb();
  const row: NewSalesTask = {
    workspaceId: input.workspaceId,
    leadId: input.leadId ?? null,
    title: input.title,
    type: input.type,
    priority: input.priority ?? 'med',
    status: input.status ?? 'open',
    dueAt: toDate(input.dueAt),
    source: input.source ?? 'manual',
    ownerUserId: input.ownerUserId ?? null,
  };
  const [inserted] = await db.insert(salesTasks).values(row).returning();
  if (!inserted) throw new Error('createTask: insert returned no row');

  try {
    await activity.emit({
      workspaceId: input.workspaceId,
      leadId: input.leadId ?? null,
      activityType: 'task_created',
      title: input.title,
      description: `[${input.type}] priority=${row.priority}${input.dueAt ? `, due ${row.dueAt!.toISOString()}` : ''}`,
      metadata: {
        task_id: inserted.id,
        type: input.type,
        priority: row.priority,
        source: row.source,
      },
      createdBy: row.source === 'AI' ? 'ai' : (input.ownerUserId ?? 'system'),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('task_created activity emit failed', err);
  }

  return inserted;
}

export interface ListTasksOpts {
  status?: SalesTaskStatus | SalesTaskStatus[];
  leadId?: string;
  ownerUserId?: string;
  limit?: number;
  before?: string;
}

/** Workspace-scoped task list. Defaults to open tasks, newest-due first. */
export async function list(
  workspaceId: string,
  opts: ListTasksOpts & { origin?: 'intake' | 'outbound' } = {},
): Promise<SalesTask[]> {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const conds = [eq(salesTasks.workspaceId, workspaceId)];
  const status = opts.status ?? 'open';
  if (Array.isArray(status)) conds.push(inArray(salesTasks.status, status));
  else conds.push(eq(salesTasks.status, status));
  if (opts.leadId) conds.push(eq(salesTasks.leadId, opts.leadId));
  if (opts.ownerUserId) conds.push(eq(salesTasks.ownerUserId, opts.ownerUserId));
  if (opts.before) conds.push(lt(salesTasks.createdAt, new Date(opts.before)));
  // Sales/Campaigns isolation. Filters via the linked lead's import_origin.
  // Tasks without a lead are treated as outbound (legacy/system tasks).
  if (opts.origin === 'intake') {
    const intakeLeads = db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.workspaceId, workspaceId), inArray(leads.importOrigin, ['intake', 'sales_manual'])));
    conds.push(inArray(salesTasks.leadId, intakeLeads));
  } else if (opts.origin === 'outbound') {
    const outboundLeads = db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.workspaceId, workspaceId),
          or(isNull(leads.importOrigin), sql`${leads.importOrigin} NOT IN ('intake', 'sales_manual')`)!,
        ),
      );
    conds.push(or(isNull(salesTasks.leadId), inArray(salesTasks.leadId, outboundLeads))!);
  }
  return db
    .select()
    .from(salesTasks)
    .where(and(...conds))
    // Open tasks sorted by due_at asc (soonest first); completed sorted by
    // completed_at desc (newest first). For mixed lists, due_at desc works
    // well enough as a single ordering.
    .orderBy(desc(salesTasks.dueAt))
    .limit(limit);
}

export async function complete(workspaceId: string, taskId: string, byUserId?: string): Promise<SalesTask> {
  const db = getDb();
  const [updated] = await db
    .update(salesTasks)
    .set({ status: 'completed', completedAt: new Date() })
    .where(and(eq(salesTasks.workspaceId, workspaceId), eq(salesTasks.id, taskId)))
    .returning();
  if (!updated) throw new Error('complete: task not found');
  try {
    await activity.emit({
      workspaceId,
      leadId: updated.leadId,
      activityType: 'task_created', // closure shows up under the same kind for now
      title: `Task completed: ${updated.title}`,
      metadata: { task_id: updated.id, transition: 'open→completed' },
      createdBy: byUserId ?? 'system',
    });
  } catch {
    // best-effort
  }
  return updated;
}

/**
 * Bulk-complete a batch of tasks in one call. Backs the multi-select +
 * bulk-action UI in the Sales Tasks (My Queue) view. Idempotent — already
 * completed/cancelled tasks are skipped. Does NOT emit per-task activity
 * rows to avoid spamming the timeline; the bulk action is logged once at
 * the caller side if needed.
 */
export async function bulkComplete(
  workspaceId: string,
  taskIds: string[],
): Promise<{ completed: number }> {
  if (taskIds.length === 0) return { completed: 0 };
  const db = getDb();
  const result = await db
    .update(salesTasks)
    .set({ status: 'completed', completedAt: new Date() })
    .where(
      and(
        eq(salesTasks.workspaceId, workspaceId),
        inArray(salesTasks.id, taskIds),
        eq(salesTasks.status, 'open'),
      ),
    )
    .returning({ id: salesTasks.id });
  return { completed: result.length };
}

export async function snooze(
  workspaceId: string,
  taskId: string,
  untilAt: Date | string,
  byUserId?: string,
): Promise<SalesTask> {
  const db = getDb();
  const newDue = toDate(untilAt)!;
  const [updated] = await db
    .update(salesTasks)
    .set({ status: 'snoozed', dueAt: newDue })
    .where(and(eq(salesTasks.workspaceId, workspaceId), eq(salesTasks.id, taskId)))
    .returning();
  if (!updated) throw new Error('snooze: task not found');
  try {
    await activity.emit({
      workspaceId,
      leadId: updated.leadId,
      activityType: 'task_created',
      title: `Task snoozed: ${updated.title}`,
      metadata: { task_id: updated.id, transition: `→snoozed until ${newDue.toISOString()}` },
      createdBy: byUserId ?? 'system',
    });
  } catch {
    // best-effort
  }
  return updated;
}

export async function countsByStatus(
  workspaceId: string,
  opts: { origin?: 'intake' | 'outbound' } = {},
): Promise<Record<SalesTaskStatus, number>> {
  const db = getDb();
  const conds = [eq(salesTasks.workspaceId, workspaceId)];
  if (opts.origin === 'intake') {
    const intakeLeads = db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.workspaceId, workspaceId), inArray(leads.importOrigin, ['intake', 'sales_manual'])));
    conds.push(inArray(salesTasks.leadId, intakeLeads));
  } else if (opts.origin === 'outbound') {
    const outboundLeads = db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.workspaceId, workspaceId),
          or(isNull(leads.importOrigin), sql`${leads.importOrigin} NOT IN ('intake', 'sales_manual')`)!,
        ),
      );
    conds.push(or(isNull(salesTasks.leadId), inArray(salesTasks.leadId, outboundLeads))!);
  }
  const rows = await db
    .select({
      status: salesTasks.status,
      n: sql<number>`count(*)::int`,
    })
    .from(salesTasks)
    .where(and(...conds))
    .groupBy(salesTasks.status);
  const out: Record<SalesTaskStatus, number> = { open: 0, completed: 0, snoozed: 0 };
  for (const r of rows) {
    if ((r.status === 'open' || r.status === 'completed' || r.status === 'snoozed')) {
      out[r.status] = r.n;
    }
  }
  return out;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  return new Date(v);
}
