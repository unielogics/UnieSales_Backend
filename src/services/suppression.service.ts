import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { suppressionList, type NewSuppressionListEntry, type SuppressionListEntry } from '../db/schema/suppression-list';
import { leads } from '../db/schema/leads';

export async function isSuppressed(workspaceId: string, email: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: suppressionList.id })
    .from(suppressionList)
    .where(and(eq(suppressionList.workspaceId, workspaceId), sql`LOWER(${suppressionList.email}) = LOWER(${email})`))
    .limit(1);
  return rows.length > 0;
}

export async function add(input: { workspaceId: string; email: string; reason?: string; source?: string }): Promise<SuppressionListEntry> {
  const db = getDb();
  const rows = await db
    .insert(suppressionList)
    .values({
      workspaceId: input.workspaceId,
      email: input.email.trim().toLowerCase(),
      reason: input.reason ?? null,
      source: input.source ?? null,
    } as NewSuppressionListEntry)
    .onConflictDoNothing()
    .returning();
  // If already suppressed, fetch existing row
  if (rows.length === 0) {
    const existing = await db
      .select()
      .from(suppressionList)
      .where(and(eq(suppressionList.workspaceId, input.workspaceId), sql`LOWER(${suppressionList.email}) = LOWER(${input.email})`))
      .limit(1);
    return existing[0]!;
  }
  return rows[0]!;
}

export async function list(workspaceId: string): Promise<SuppressionListEntry[]> {
  const db = getDb();
  return db.select().from(suppressionList).where(eq(suppressionList.workspaceId, workspaceId));
}

export async function removeById(workspaceId: string, entryId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .delete(suppressionList)
    .where(and(eq(suppressionList.workspaceId, workspaceId), eq(suppressionList.id, entryId)))
    .returning({ id: suppressionList.id });
  return rows.length > 0;
}

/**
 * Suppress an email AND close every matching lead in the workspace.
 * Returns suppression entry plus number of leads marked closed_unsubscribed.
 */
export async function suppressEmailAndCloseLeads(
  workspaceId: string,
  email: string,
  reason?: string,
): Promise<{ suppression: SuppressionListEntry; leadsClosed: number }> {
  const db = getDb();
  const suppression = await add({ workspaceId, email, reason, source: 'manual' });
  const result = await db
    .update(leads)
    .set({
      status: 'closed_unsubscribed',
      lifecycleStatus: 'closed',
      closeReason: 'suppressed',
      closedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(leads.workspaceId, workspaceId), sql`LOWER(${leads.email}) = LOWER(${email})`))
    .returning({ id: leads.id });
  return { suppression, leadsClosed: result.length };
}
