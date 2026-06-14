/**
 * Scheduled notification scans — the proactive half of the notification system.
 *
 * Unlike the reactive emits (a reply lands, a meeting is booked), these surface
 * things that become important with the passage of time: a task hitting its due
 * date, a deal going stale, and the once-a-day digest. Driven by the
 * notifications worker; each scan is best-effort and dedup'd so a recipient is
 * never spammed on every tick.
 */
import { and, eq, gte, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { leads } from '../db/schema/leads';
import { salesTasks } from '../db/schema/sales-tasks';
import { notifications } from '../db/schema/notifications';
import { workspaces } from '../db/schema/workspaces';
import * as notify from './notification.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DAYS = 7;
const BATCH = 100;

/** Open tasks whose due time has passed and that we haven't alerted on yet. */
export async function scanTaskDue(): Promise<number> {
  const db = getDb();
  const now = new Date();
  const due = await db
    .select({
      id: salesTasks.id,
      workspaceId: salesTasks.workspaceId,
      leadId: salesTasks.leadId,
      title: salesTasks.title,
      priority: salesTasks.priority,
      ownerUserId: salesTasks.ownerUserId,
      dueAt: salesTasks.dueAt,
    })
    .from(salesTasks)
    .where(
      and(
        eq(salesTasks.status, 'open'),
        isNull(salesTasks.dueNotifiedAt),
        lte(salesTasks.dueAt, now),
      ),
    )
    .limit(BATCH);

  for (const t of due) {
    await notify.emit({
      workspaceId: t.workspaceId,
      userId: t.ownerUserId ?? null,
      leadId: t.leadId ?? null,
      kind: 'task',
      priority: t.priority === 'high' ? 'high' : 'normal',
      title: `Task due — ${t.title}`,
      meta: t.dueAt ? `due ${t.dueAt.toISOString().slice(0, 16).replace('T', ' ')}` : null,
    });
    await db
      .update(salesTasks)
      .set({ dueNotifiedAt: now })
      .where(eq(salesTasks.id, t.id));
  }
  return due.length;
}

/**
 * Active leads that have gone quiet: next action overdue, or no scheduled action
 * and untouched for a week. Re-alerts at most once a week per lead.
 */
export async function scanDealRisk(): Promise<number> {
  const db = getDb();
  const now = new Date();
  const weekAgo = new Date(now.getTime() - STALE_DAYS * DAY_MS);

  const atRisk = await db
    .select({
      id: leads.id,
      workspaceId: leads.workspaceId,
      companyName: leads.companyName,
      contactName: leads.contactName,
      email: leads.email,
      nextActionAt: leads.nextActionAt,
    })
    .from(leads)
    .where(
      and(
        eq(leads.lifecycleStatus, 'active'),
        or(
          lt(leads.nextActionAt, now),
          and(isNull(leads.nextActionAt), lt(leads.updatedAt, weekAgo)),
        ),
        or(isNull(leads.riskNotifiedAt), lt(leads.riskNotifiedAt, weekAgo)),
      ),
    )
    .limit(BATCH);

  for (const l of atRisk) {
    const who = l.companyName ?? l.contactName ?? l.email;
    const reason = l.nextActionAt ? 'Next action overdue' : `No movement in ${STALE_DAYS} days`;
    await notify.emit({
      workspaceId: l.workspaceId,
      leadId: l.id,
      kind: 'deal_risk',
      priority: 'high',
      title: `Deal at risk — ${who}`,
      body: reason,
    });
    await db
      .update(leads)
      .set({ riskNotifiedAt: now })
      .where(eq(leads.id, l.id));
  }
  return atRisk.length;
}

/**
 * Once-a-day digest per workspace. Dedup'd so a worker restart can't double-send
 * the same calendar day. Counts the last 24h of activity from the feed + leads.
 */
export async function sendDailySummary(): Promise<number> {
  const db = getDb();
  const now = new Date();
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const wss = await db.select({ id: workspaces.id }).from(workspaces);
  let sent = 0;

  for (const ws of wss) {
    // Skip if today's summary already went out (idempotent across restarts).
    const [existing] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, ws.id),
          eq(notifications.kind, 'summary'),
          gte(notifications.createdAt, startOfToday),
        ),
      )
      .limit(1);
    if (existing) continue;

    const [newLeads] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(leads)
      .where(and(eq(leads.workspaceId, ws.id), gte(leads.createdAt, dayAgo)));

    const byKind = await db
      .select({ kind: notifications.kind, c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.workspaceId, ws.id), gte(notifications.createdAt, dayAgo)))
      .groupBy(notifications.kind);
    const k = (name: string) => byKind.find((r) => r.kind === name)?.c ?? 0;

    const replies = k('reply') + k('objection');
    const bookings = k('booking');
    const wins = k('won');
    const parts = [
      `${newLeads?.c ?? 0} new leads`,
      `${replies} replies`,
      `${bookings} meetings booked`,
      `${wins} won`,
    ];

    await notify.emit({
      workspaceId: ws.id,
      kind: 'summary',
      priority: 'low',
      title: 'Your UnieSales morning briefing',
      body: parts.join(' · '),
    });
    sent += 1;
  }
  return sent;
}
