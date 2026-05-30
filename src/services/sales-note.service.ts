/**
 * sales-notes service — manual + AI-generated notes on a lead's timeline.
 *
 * Every note insert also writes a paired `note_created` activity row so the
 * Activity tab stays the single source of truth for "what happened, when."
 * That's the only cross-service write — the notes table itself is otherwise
 * isolated from activities.
 */
import { and, desc, eq, lt } from 'drizzle-orm';
import { getDb } from '../config/db';
import {
  salesNotes,
  type SalesNote,
  type NewSalesNote,
  type SalesNoteKind,
} from '../db/schema/sales-notes';
import * as activity from './sales-activity.service';

export interface CreateNoteInput {
  workspaceId: string;
  leadId: string;
  kind: SalesNoteKind;
  body: string;
  title?: string | null;
  authorUserId?: string | null;
  aiActionId?: string | null;
}

export async function create(input: CreateNoteInput): Promise<SalesNote> {
  const db = getDb();
  const row: NewSalesNote = {
    workspaceId: input.workspaceId,
    leadId: input.leadId,
    kind: input.kind,
    body: input.body,
    title: input.title ?? null,
    authorUserId: input.authorUserId ?? null,
    aiActionId: input.aiActionId ?? null,
  };
  const [inserted] = await db.insert(salesNotes).values(row).returning();
  if (!inserted) throw new Error('createNote: insert returned no row');

  // Mirror to activity feed. Errors here must not roll back the note — if
  // the activity write fails the lead modal will be missing a timeline entry
  // but the note itself is still recoverable.
  try {
    await activity.emit({
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      activityType: 'note_created',
      title: input.title ?? `${kindLabel(input.kind)} note`,
      description: input.body.length > 240 ? input.body.slice(0, 237) + '…' : input.body,
      metadata: { note_id: inserted.id, kind: input.kind },
      createdBy: input.authorUserId ?? (input.aiActionId ? 'ai' : 'system'),
    });
  } catch (err) {
    // Best-effort. The note is what the user actually cares about.
    // eslint-disable-next-line no-console
    console.warn('note_created activity emit failed', err);
  }

  return inserted;
}

export interface ListForLeadOpts {
  limit?: number;
  before?: string;
  kind?: SalesNoteKind;
}

export async function listForLead(
  workspaceId: string,
  leadId: string,
  opts: ListForLeadOpts = {},
): Promise<SalesNote[]> {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conds = [eq(salesNotes.workspaceId, workspaceId), eq(salesNotes.leadId, leadId)];
  if (opts.kind) conds.push(eq(salesNotes.kind, opts.kind));
  if (opts.before) conds.push(lt(salesNotes.createdAt, new Date(opts.before)));
  return db
    .select()
    .from(salesNotes)
    .where(and(...conds))
    .orderBy(desc(salesNotes.createdAt))
    .limit(limit);
}

function kindLabel(kind: SalesNoteKind): string {
  switch (kind) {
    case 'manual': return 'Manual';
    case 'ai_summary': return 'AI summary';
    case 'reply_summary': return 'Reply summary';
    case 'meeting_prep': return 'Meeting prep';
    case 'objection': return 'Objection';
    case 'handoff': return 'Handoff';
    case 'post_call': return 'Post-call';
    case 'intake_summary': return 'Intake';
    default: return 'Note';
  }
}
