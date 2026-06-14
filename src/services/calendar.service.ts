/**
 * Calendar service — two-way mirror between the app and Google Calendar.
 *
 *  - syncFromGoogle: pulls the operator's real GCal events into calendar_events
 *  - createEvent:    pushes a new event to GCal (optionally with a Meet link)
 *  - bookMeetingFromReply: AI-driven — books a tentative call + Meet link when
 *    a lead's email asks to schedule
 *
 * Reuses the Gmail OAuth client (one Google account already grants Calendar
 * scopes — see config/google.ts).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, between, desc, eq, inArray, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { google, type Auth } from 'googleapis';
import { getDb } from '../config/db';
import { calendarEvents, type CalendarEvent, type CalendarAttendee } from '../db/schema/calendar-events';
import { gmailAccounts, type GmailAccount } from '../db/schema/gmail-accounts';
import { leads } from '../db/schema/leads';
import { salesTasks } from '../db/schema/sales-tasks';
import { workspaces, type CalendarConfig } from '../db/schema/workspaces';
import type { WorkspaceRole } from '../db/schema/workspace-members';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import { authClientForAccount, getAccount } from './gmail.service';
import * as notify from './notification.service';
import * as salesActivity from './sales-activity.service';
import * as salesNote from './sales-note.service';
import * as salesTask from './sales-task.service';

const INBOUND_WORKSPACE_ID = '00000000-0000-4000-a000-000000000001';

function calendarClient(auth: Auth.OAuth2Client) {
  return google.calendar({ version: 'v3', auth });
}

/** First active Gmail/Google account on the workspace, or a specific one. */
async function resolveAccount(workspaceId: string, gmailAccountId?: string): Promise<GmailAccount> {
  if (gmailAccountId) return getAccount(workspaceId, gmailAccountId);
  const db = getDb();
  const rows = await db
    .select()
    .from(gmailAccounts)
    .where(and(eq(gmailAccounts.workspaceId, workspaceId), eq(gmailAccounts.isActive, true)))
    .orderBy(desc(gmailAccounts.createdAt))
    .limit(1);
  if (!rows[0]) throw new ConflictError('No active Google account on this workspace');
  return rows[0];
}

function toDate(g: { dateTime?: string | null; date?: string | null } | undefined | null): Date | null {
  if (!g) return null;
  if (g.dateTime) return new Date(g.dateTime);
  if (g.date) return new Date(`${g.date}T00:00:00`);
  return null;
}

function extractMeetLink(ev: {
  hangoutLink?: string | null;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string | null; uri?: string | null }> } | null;
}): string | null {
  if (ev.hangoutLink) return ev.hangoutLink;
  const ep = ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video');
  return ep?.uri ?? null;
}

async function findUniqueActiveLeadForAttendees(
  workspaceId: string,
  accountEmail: string,
  attendees: CalendarAttendee[],
): Promise<{ id: string; campaignId: string | null } | null> {
  const emails = [...new Set(
    attendees
      .map((a) => a.email.trim().toLowerCase())
      .filter((email) => email && email !== accountEmail.trim().toLowerCase()),
  )];
  if (emails.length === 0) return null;
  const db = getDb();
  const matches = await db
    .select({ id: leads.id, campaignId: leads.campaignId })
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, workspaceId),
        eq(leads.lifecycleStatus, 'active'),
        sql`lower(${leads.email}) in (${sql.join(emails.map((email) => sql`${email}`), sql`,`)})`,
      ),
    )
    .limit(2);
  return matches.length === 1 ? matches[0]! : null;
}

interface ManualLeadSnapshot {
  contactName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  title?: string | null;
  segment?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  website?: string | null;
  city?: string | null;
  state?: string | null;
  streetAddress?: string | null;
  addressFull?: string | null;
  source?: string | null;
  sourceUrl?: string | null;
  sourceNotes?: string | null;
}

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function splitContactName(name: string | null | undefined): { firstName: string | null; lastName: string | null } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  return {
    firstName: parts[0] ?? null,
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : null,
  };
}

function manualLeadValues(
  workspaceId: string,
  account: GmailAccount,
  email: string,
  attendee: CalendarAttendee | undefined,
  snapshot?: ManualLeadSnapshot | null,
): typeof leads.$inferInsert {
  const snapshotName = nonBlank(snapshot?.contactName);
  const attendeeName = nonBlank(attendee?.name);
  const contactName = snapshotName ?? attendeeName;
  const split = splitContactName(contactName);
  const inbound = workspaceId === INBOUND_WORKSPACE_ID;
  return {
    workspaceId,
    gmailAccountId: account.id,
    contactName,
    firstName: nonBlank(snapshot?.firstName) ?? split.firstName,
    lastName: nonBlank(snapshot?.lastName) ?? split.lastName,
    companyName: nonBlank(snapshot?.companyName),
    title: nonBlank(snapshot?.title),
    segment: nonBlank(snapshot?.segment),
    email,
    phone: nonBlank(snapshot?.phone),
    linkedinUrl: nonBlank(snapshot?.linkedinUrl),
    website: nonBlank(snapshot?.website),
    city: nonBlank(snapshot?.city),
    state: nonBlank(snapshot?.state),
    streetAddress: nonBlank(snapshot?.streetAddress),
    addressFull: nonBlank(snapshot?.addressFull),
    source: nonBlank(snapshot?.source) ?? 'manual_meeting',
    sourceUrl: nonBlank(snapshot?.sourceUrl),
    sourceNotes: nonBlank(snapshot?.sourceNotes) ?? 'Created automatically from a manually scheduled meeting.',
    status: 'call_scheduled',
    lifecycleStatus: 'active',
    pipelineStage: inbound ? 'booked' : null,
    importOrigin: inbound ? 'intake' : 'manual',
    channel: 'email',
    aiOwner: false,
  };
}

function missingDetailPatch(
  lead: typeof leads.$inferSelect,
  values: Partial<typeof leads.$inferInsert>,
): Partial<typeof leads.$inferInsert> {
  const fields = [
    'contactName',
    'firstName',
    'lastName',
    'companyName',
    'title',
    'segment',
    'phone',
    'linkedinUrl',
    'website',
    'city',
    'state',
    'streetAddress',
    'addressFull',
    'sourceUrl',
    'sourceNotes',
  ] as const;
  const patch: Partial<typeof leads.$inferInsert> = {};
  for (const field of fields) {
    if (!nonBlank(lead[field]) && nonBlank(values[field] as string | null | undefined)) {
      patch[field] = values[field] as never;
    }
  }
  if ((!lead.source || lead.source === 'manual_meeting') && values.source && values.source !== 'manual_meeting') {
    patch.source = values.source;
  }
  return patch;
}

async function resolveOrCreateLeadForManualEvent(
  workspaceId: string,
  account: GmailAccount,
  attendees: CalendarAttendee[],
  requestedLeadId?: string | null,
  snapshot?: ManualLeadSnapshot | null,
): Promise<{ id: string; campaignId: string | null } | null> {
  const db = getDb();
  if (requestedLeadId) {
    const [requested] = await db
      .select()
      .from(leads)
      .where(and(eq(leads.id, requestedLeadId), isNull(leads.deletedAt)))
      .limit(1);
    if (requested?.workspaceId === workspaceId && requested.lifecycleStatus === 'active') {
      return { id: requested.id, campaignId: requested.campaignId };
    }
  }

  const accountEmail = account.email.trim().toLowerCase();
  const attendee = attendees.find((a) => {
    const email = a.email?.trim().toLowerCase();
    return email && email !== accountEmail;
  });
  const email = attendee?.email?.trim().toLowerCase();
  if (!email) return null;

  const values = manualLeadValues(workspaceId, account, email, attendee, snapshot);
  const existing = await db
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, workspaceId),
        eq(leads.lifecycleStatus, 'active'),
        isNull(leads.deletedAt),
        sql`lower(${leads.email}) = ${email}`,
      ),
    )
    .orderBy(desc(leads.updatedAt))
    .limit(1);
  if (existing[0]) {
    const patch = missingDetailPatch(existing[0], values);
    if (Object.keys(patch).length > 0) {
      await db
        .update(leads)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, existing[0].id)));
    }
    return { id: existing[0].id, campaignId: existing[0].campaignId };
  }

  const [created] = await db
    .insert(leads)
    .values(values)
    .returning({ id: leads.id, campaignId: leads.campaignId });
  return created ?? null;
}

/**
 * Pull events from the account's primary Google Calendar (now-7d → now+60d)
 * and upsert them into calendar_events with source='google'.
 */
export async function syncFromGoogle(workspaceId: string, gmailAccountId: string): Promise<{ synced: number }> {
  const account = await getAccount(workspaceId, gmailAccountId);
  if (!account.isActive) return { synced: 0 };

  const auth = await authClientForAccount(account);
  const cal = calendarClient(auth);

  const timeMin = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const timeMax = new Date(Date.now() + 60 * 86_400_000).toISOString();

  const db = getDb();
  let synced = 0;
  const seenGoogleEventIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500,
      showDeleted: true,
      pageToken,
    });

    for (const ev of res.data.items ?? []) {
      if (!ev.id) continue;
      seenGoogleEventIds.push(ev.id);
      const startAt = toDate(ev.start);
      const endAt = toDate(ev.end);

      if (ev.status === 'cancelled') {
        await db
          .update(calendarEvents)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(and(eq(calendarEvents.gmailAccountId, account.id), eq(calendarEvents.googleEventId, ev.id)));
        synced++;
        continue;
      }

      if (!startAt || !endAt) continue;

      const attendees: CalendarAttendee[] = (ev.attendees ?? []).map((a) => ({
        email: a.email ?? '',
        name: a.displayName ?? undefined,
        responseStatus: a.responseStatus ?? undefined,
      }));
      const matchedLead = await findUniqueActiveLeadForAttendees(workspaceId, account.email, attendees);

      await db
        .insert(calendarEvents)
        .values({
          workspaceId,
          gmailAccountId: account.id,
          leadId: matchedLead?.id ?? null,
          campaignId: matchedLead?.campaignId ?? null,
          googleEventId: ev.id,
          googleCalendarId: 'primary',
          title: ev.summary ?? '(no title)',
          description: ev.description ?? null,
          startAt,
          endAt,
          attendees,
          meetLink: extractMeetLink(ev),
          location: ev.location ?? null,
          status: 'confirmed',
          source: 'google',
        })
        .onConflictDoUpdate({
          target: [calendarEvents.gmailAccountId, calendarEvents.googleEventId],
          set: {
            title: ev.summary ?? '(no title)',
            description: ev.description ?? null,
            startAt,
            endAt,
            attendees,
            leadId: sql`coalesce(${calendarEvents.leadId}, ${matchedLead?.id ?? null})` as never,
            campaignId: sql`coalesce(${calendarEvents.campaignId}, ${matchedLead?.campaignId ?? null})` as never,
            meetLink: extractMeetLink(ev),
            location: ev.location ?? null,
            status: 'confirmed',
            updatedAt: new Date(),
          },
        });
      synced++;
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const staleFilters = [
    eq(calendarEvents.workspaceId, workspaceId),
    eq(calendarEvents.gmailAccountId, account.id),
    eq(calendarEvents.googleCalendarId, 'primary'),
    eq(calendarEvents.source, 'google'),
    ne(calendarEvents.status, 'cancelled'),
    between(calendarEvents.startAt, new Date(timeMin), new Date(timeMax)),
    ...(seenGoogleEventIds.length > 0 ? [notInArray(calendarEvents.googleEventId, seenGoogleEventIds)] : []),
  ];
  const stale = await db
    .update(calendarEvents)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(...staleFilters))
    .returning({ id: calendarEvents.id });

  return { synced: synced + stale.length };
}

/** Sync every active account on the workspace; tolerant of per-account failures. */
export async function syncWorkspace(workspaceId: string): Promise<{ synced: number }> {
  const db = getDb();
  const accounts = await db
    .select()
    .from(gmailAccounts)
    .where(and(eq(gmailAccounts.workspaceId, workspaceId), eq(gmailAccounts.isActive, true)));
  let synced = 0;
  for (const a of accounts) {
    try {
      const r = await syncFromGoogle(workspaceId, a.id);
      synced += r.synced;
    } catch {
      // skip a broken account, keep the rest
    }
  }
  return { synced };
}

export async function listEvents(
  workspaceId: string,
  range: { from: Date; to: Date },
): Promise<CalendarEvent[]> {
  const db = getDb();
  return db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.workspaceId, workspaceId),
        between(calendarEvents.startAt, range.from, range.to),
      ),
    )
    .orderBy(calendarEvents.startAt)
    .limit(500);
}

export async function getById(workspaceId: string, eventId: string): Promise<CalendarEvent> {
  const db = getDb();
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(and(eq(calendarEvents.workspaceId, workspaceId), eq(calendarEvents.id, eventId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError('Calendar event not found');
  return rows[0];
}

export interface CreateEventInput {
  gmailAccountId?: string;
  title: string;
  description?: string;
  startAt: Date;
  endAt: Date;
  attendees?: CalendarAttendee[];
  leadId?: string | null;
  campaignId?: string | null;
  leadSnapshot?: ManualLeadSnapshot | null;
  emailThreadId?: string | null;
  location?: string;
  withMeet?: boolean;
  source?: 'app' | 'ai_booked';
}

/** Push a new event to Google Calendar (optionally with a Meet link) + persist. */
export async function createEvent(workspaceId: string, input: CreateEventInput): Promise<CalendarEvent> {
  const account = await resolveAccount(workspaceId, input.gmailAccountId);
  const auth = await authClientForAccount(account);
  const cal = calendarClient(auth);
  const withMeet = input.withMeet !== false; // default on
  const linkedLead = await resolveOrCreateLeadForManualEvent(
    workspaceId,
    account,
    input.attendees ?? [],
    input.leadId,
    input.leadSnapshot,
  );

  const res = await cal.events.insert({
    calendarId: 'primary',
    conferenceDataVersion: withMeet ? 1 : 0,
    sendUpdates: 'all',
    requestBody: {
      summary: input.title,
      description: input.description,
      location: input.location,
      start: { dateTime: input.startAt.toISOString() },
      end: { dateTime: input.endAt.toISOString() },
      attendees: (input.attendees ?? []).map((a) => ({ email: a.email, displayName: a.name })),
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 },
          { method: 'popup', minutes: 60 },
          { method: 'popup', minutes: 10 },
        ],
      },
      conferenceData: withMeet
        ? { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
        : undefined,
    },
  });

  const ev = res.data;
  const db = getDb();
  const rows = await db
    .insert(calendarEvents)
    .values({
      workspaceId,
      gmailAccountId: account.id,
      leadId: linkedLead?.id ?? null,
      campaignId: linkedLead?.campaignId ?? input.campaignId ?? null,
      emailThreadId: input.emailThreadId ?? null,
      googleEventId: ev.id ?? null,
      googleCalendarId: 'primary',
      title: input.title,
      description: input.description ?? null,
      startAt: input.startAt,
      endAt: input.endAt,
      attendees: input.attendees ?? [],
      meetLink: extractMeetLink(ev ?? {}),
      location: input.location ?? null,
      status: 'confirmed',
      source: input.source ?? 'app',
    })
    .returning();
  return rows[0]!;
}

export interface UpdateEventInput {
  title?: string;
  description?: string;
  startAt?: Date;
  endAt?: Date;
  location?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
}

/** Update an event locally and mirror the change to Google Calendar. */
export async function updateEvent(
  workspaceId: string,
  eventId: string,
  patch: UpdateEventInput,
): Promise<CalendarEvent> {
  const existing = await getById(workspaceId, eventId);
  const db = getDb();

  const rows = await db
    .update(calendarEvents)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(calendarEvents.id, existing.id))
    .returning();
  const updated = rows[0]!;

  // Mirror to Google (best-effort — local row is the source of truth for the UI).
  if (existing.googleEventId) {
    try {
      const account = await getAccount(workspaceId, existing.gmailAccountId);
      const auth = await authClientForAccount(account);
      const cal = calendarClient(auth);
      if (patch.status === 'cancelled') {
        await cal.events.delete({ calendarId: 'primary', eventId: existing.googleEventId, sendUpdates: 'all' });
      } else {
        await cal.events.patch({
          calendarId: 'primary',
          eventId: existing.googleEventId,
          sendUpdates: 'all',
          requestBody: {
            summary: updated.title,
            description: updated.description ?? undefined,
            location: updated.location ?? undefined,
            start: { dateTime: updated.startAt.toISOString() },
            end: { dateTime: updated.endAt.toISOString() },
          },
        });
      }
    } catch {
      // Google mirror failed — local update still stands.
    }
  }
  return updated;
}

export async function cancelEvent(workspaceId: string, eventId: string): Promise<CalendarEvent> {
  return updateEvent(workspaceId, eventId, { status: 'cancelled' });
}

/**
 * Bulk-cancel calendar events. Mirrors cancelEvent for a batch. Skips events
 * that are already cancelled (idempotent). Does NOT push to Google Calendar
 * yet — same behaviour as the single-event cancelEvent (which also only
 * flips the local row). Operator can wire Google-side cancellation later.
 */
export async function bulkCancelEvents(
  workspaceId: string,
  eventIds: string[],
): Promise<{ cancelled: number }> {
  if (eventIds.length === 0) return { cancelled: 0 };
  const db = getDb();
  const result = await db
    .update(calendarEvents)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(
      and(
        eq(calendarEvents.workspaceId, workspaceId),
        inArray(calendarEvents.id, eventIds),
        ne(calendarEvents.status, 'cancelled'),
      ),
    )
    .returning({ id: calendarEvents.id });
  return { cancelled: result.length };
}

export type MeetingOutcome = 'success' | 'failure';
export type OutcomeReason = 'no_show' | 'bad_fit' | 'budget' | 'timing' | 'competitor';
export type OutcomeNextAction =
  | 'schedule_follow_up'
  | 'send_proposal'
  | 'move_to_contracting'
  | 'close_won'
  | 'attempt_reschedule'
  | 'nurture';

export interface PostCallPendingEvent {
  event: CalendarEvent;
  lead: {
    id: string;
    contactName: string | null;
    companyName: string | null;
    email: string;
    pipelineStage: string | null;
  } | null;
}

function canManageOutcome(
  account: Pick<GmailAccount, 'connectedByUserId'>,
  userId: string,
  role: WorkspaceRole,
): boolean {
  if (account.connectedByUserId) return account.connectedByUserId === userId;
  return role === 'owner' || role === 'admin';
}

function outcomeBaseFilters(workspaceId: string, now: Date, includeSnoozed: boolean) {
  return [
    eq(calendarEvents.workspaceId, workspaceId),
    ne(calendarEvents.status, 'cancelled'),
    lte(calendarEvents.endAt, now),
    isNull(calendarEvents.outcomeLoggedAt),
    sql`${calendarEvents.leadId} is not null`,
    ...(includeSnoozed
      ? []
      : [or(isNull(calendarEvents.outcomeSnoozedUntil), lte(calendarEvents.outcomeSnoozedUntil, now))!]),
  ];
}

export async function listPendingOutcomes(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  opts: { includeSnoozed?: boolean; limit?: number } = {},
): Promise<{ events: PostCallPendingEvent[]; count: number }> {
  const db = getDb();
  const now = new Date();
  const rows = await db
    .select({ event: calendarEvents, account: gmailAccounts, lead: leads })
    .from(calendarEvents)
    .innerJoin(gmailAccounts, eq(calendarEvents.gmailAccountId, gmailAccounts.id))
    .leftJoin(leads, eq(calendarEvents.leadId, leads.id))
    .where(and(...outcomeBaseFilters(workspaceId, now, opts.includeSnoozed === true)))
    .orderBy(asc(calendarEvents.endAt))
    .limit(Math.min(Math.max(opts.limit ?? 25, 1), 100));

  const visible = rows
    .filter((r) => canManageOutcome(r.account, userId, role))
    .map((r) => ({
      event: r.event,
      lead: r.lead
        ? {
            id: r.lead.id,
            contactName: r.lead.contactName,
            companyName: r.lead.companyName,
            email: r.lead.email,
            pipelineStage: r.lead.pipelineStage,
          }
        : null,
    }));
  return { events: visible, count: visible.length };
}

async function getOutcomeEventForUser(
  workspaceId: string,
  eventId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<{ event: CalendarEvent; account: GmailAccount; lead: typeof leads.$inferSelect | null }> {
  const db = getDb();
  const [row] = await db
    .select({ event: calendarEvents, account: gmailAccounts, lead: leads })
    .from(calendarEvents)
    .innerJoin(gmailAccounts, eq(calendarEvents.gmailAccountId, gmailAccounts.id))
    .leftJoin(leads, eq(calendarEvents.leadId, leads.id))
    .where(and(eq(calendarEvents.workspaceId, workspaceId), eq(calendarEvents.id, eventId)))
    .limit(1);
  if (!row) throw new NotFoundError('Calendar event not found');
  if (!canManageOutcome(row.account, userId, role)) {
    throw new ForbiddenError('Only the meeting host can log this outcome');
  }
  return row;
}

async function pendingCountForUser(workspaceId: string, userId: string, role: WorkspaceRole): Promise<number> {
  return (await listPendingOutcomes(workspaceId, userId, role, { limit: 100 })).count;
}

function requireNotes(notes: string) {
  if (!notes.trim()) {
    throw new ValidationError('Meeting notes are required', [
      { field: 'notes', reason: 'Add the call notes before logging the outcome' },
    ]);
  }
}

function outcomeNoteBody(input: {
  outcome: MeetingOutcome;
  reason?: OutcomeReason | null;
  notes: string;
  nextAction?: OutcomeNextAction | null;
  meetTranscriptText?: string | null;
  meetNotesText?: string | null;
}): string {
  const parts = [
    `Outcome: ${input.outcome}`,
    input.reason ? `Reason: ${input.reason}` : null,
    input.nextAction ? `Next action: ${input.nextAction}` : null,
    '',
    input.notes.trim(),
  ].filter((v): v is string => v !== null);
  if (input.meetNotesText) {
    parts.push('', 'Google Meet notes:', input.meetNotesText.slice(0, 4000));
  }
  if (input.meetTranscriptText) {
    parts.push('', 'Google Meet transcript excerpt:', input.meetTranscriptText.slice(0, 4000));
  }
  return parts.join('\n');
}

export async function logOutcome(
  workspaceId: string,
  eventId: string,
  userId: string,
  role: WorkspaceRole,
  input: {
    outcome: MeetingOutcome;
    notes: string;
    reason?: OutcomeReason | null;
    nextAction?: OutcomeNextAction | null;
    followUp?: { title?: string; startAt: Date; endAt: Date } | null;
  },
): Promise<{ event: CalendarEvent; pendingCount: number }> {
  requireNotes(input.notes);
  const { event, lead } = await getOutcomeEventForUser(workspaceId, eventId, userId, role);
  if (!event.leadId || !lead) throw new ConflictError('This meeting is not linked to a lead');
  if (event.outcomeLoggedAt) {
    return { event, pendingCount: await pendingCountForUser(workspaceId, userId, role) };
  }
  if (input.outcome === 'failure' && !input.reason) {
    throw new ValidationError('Failure reason is required', [
      { field: 'reason', reason: 'Choose why the meeting did not move forward' },
    ]);
  }
  if (input.outcome === 'success' && !input.nextAction) {
    throw new ValidationError('Next action is required', [
      { field: 'nextAction', reason: 'Choose the next action for a successful meeting' },
    ]);
  }

  let nextStepTaskId: string | null = null;
  let nextStepCalendarEventId: string | null = null;
  const who = lead.contactName || lead.companyName || lead.email;

  if (input.outcome === 'success') {
    if (input.nextAction === 'schedule_follow_up' && input.followUp) {
      const followUp = await createEvent(workspaceId, {
        gmailAccountId: event.gmailAccountId,
        title: input.followUp.title || `Follow-up call · ${who}`,
        description: `Follow-up from ${event.title}`,
        startAt: input.followUp.startAt,
        endAt: input.followUp.endAt,
        attendees: [{ email: lead.email, name: lead.contactName ?? undefined }],
        leadId: lead.id,
        campaignId: lead.campaignId,
        emailThreadId: event.emailThreadId,
        withMeet: true,
        source: 'app',
      });
      nextStepCalendarEventId = followUp.id;
    } else if (input.nextAction === 'send_proposal') {
      const task = await salesTask.create({
        workspaceId,
        leadId: lead.id,
        title: `Send proposal to ${who}`,
        type: 'send_proposal',
        priority: 'high',
        dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        ownerUserId: userId,
      });
      nextStepTaskId = task.id;
      await updateLeadStage(workspaceId, lead.id, { pipelineStage: 'opportunity' });
    } else if (input.nextAction === 'move_to_contracting') {
      const task = await salesTask.create({
        workspaceId,
        leadId: lead.id,
        title: `Move ${who} to contracting`,
        type: 'human_handoff',
        priority: 'high',
        ownerUserId: userId,
      });
      nextStepTaskId = task.id;
      await updateLeadStage(workspaceId, lead.id, { pipelineStage: 'opportunity' });
    } else if (input.nextAction === 'close_won') {
      await updateLeadStage(workspaceId, lead.id, {
        pipelineStage: 'won',
        lifecycleStatus: 'closed',
        closeReason: 'won_after_meeting',
        closedAt: new Date(),
      });
      await notify.emit({
        workspaceId,
        userId,
        leadId: lead.id,
        kind: 'won',
        priority: 'high',
        title: `Closed won — ${who}`,
        body: event.title,
      });
    }
  } else {
    if (input.reason === 'bad_fit' || input.reason === 'competitor') {
      await updateLeadStage(workspaceId, lead.id, {
        pipelineStage: 'lost',
        lifecycleStatus: 'closed',
        closeReason: input.reason,
        closedAt: new Date(),
      });
    } else if (input.reason === 'budget' || input.reason === 'timing' || input.nextAction === 'nurture') {
      const dueAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      const task = await salesTask.create({
        workspaceId,
        leadId: lead.id,
        title: `Nurture ${who}`,
        type: 'follow_up_manual',
        priority: 'med',
        dueAt,
        ownerUserId: userId,
      });
      nextStepTaskId = task.id;
      await updateLeadStage(workspaceId, lead.id, {
        pipelineStage: 'nurture_later',
        nextActionAt: dueAt,
      });
    } else if (input.reason === 'no_show' || input.nextAction === 'attempt_reschedule') {
      const task = await salesTask.create({
        workspaceId,
        leadId: lead.id,
        title: `Attempt reschedule with ${who}`,
        type: 'call_lead',
        priority: 'high',
        dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        ownerUserId: userId,
      });
      nextStepTaskId = task.id;
    }
  }

  const db = getDb();
  const [updated] = await db
    .update(calendarEvents)
    .set({
      outcomeStatus: input.reason === 'no_show' ? 'no_show' : 'completed',
      meetingOutcome: input.outcome,
      outcomeReason: input.reason ?? null,
      outcomeNotes: input.notes.trim(),
      outcomeNextAction: input.nextAction ?? null,
      outcomeLoggedAt: new Date(),
      outcomeLoggedByUserId: userId,
      outcomeSnoozedUntil: null,
      nextStepTaskId,
      nextStepCalendarEventId,
      updatedAt: new Date(),
    })
    .where(eq(calendarEvents.id, event.id))
    .returning();
  if (!updated) throw new Error('logOutcome: update returned no row');

  if (event.outcomeTaskId) {
    await salesTask.complete(workspaceId, event.outcomeTaskId, userId).catch(() => undefined);
  }

  await salesNote.create({
    workspaceId,
    leadId: lead.id,
    kind: 'post_call',
    title: `Post-call outcome · ${event.title}`,
    body: outcomeNoteBody({
      outcome: input.outcome,
      reason: input.reason,
      nextAction: input.nextAction,
      notes: input.notes,
      meetNotesText: event.meetNotesText,
      meetTranscriptText: event.meetTranscriptText,
    }),
    authorUserId: userId,
  });

  await salesActivity.emit({
    workspaceId,
    leadId: lead.id,
    campaignId: lead.campaignId,
    activityType: 'meeting_outcome_logged',
    title: input.outcome === 'success' ? 'Meeting logged as successful' : 'Meeting logged as failed',
    description: input.reason ?? input.nextAction ?? null,
    metadata: {
      event_id: event.id,
      outcome: input.outcome,
      reason: input.reason ?? null,
      next_action: input.nextAction ?? null,
      next_step_task_id: nextStepTaskId,
      next_step_calendar_event_id: nextStepCalendarEventId,
    },
    createdBy: userId,
  });

  return { event: updated, pendingCount: await pendingCountForUser(workspaceId, userId, role) };
}

async function updateLeadStage(
  workspaceId: string,
  leadId: string,
  patch: Partial<Pick<typeof leads.$inferInsert, 'pipelineStage' | 'lifecycleStatus' | 'closeReason' | 'closedAt' | 'nextActionAt'>>,
) {
  const db = getDb();
  await db
    .update(leads)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)));
}

export async function snoozeOutcome(
  workspaceId: string,
  eventId: string,
  userId: string,
  role: WorkspaceRole,
  untilAt: Date,
): Promise<{ event: CalendarEvent; taskId: string | null; pendingCount: number }> {
  const { event, lead } = await getOutcomeEventForUser(workspaceId, eventId, userId, role);
  if (!event.leadId || !lead) throw new ConflictError('This meeting is not linked to a lead');
  let taskId = event.outcomeTaskId;
  if (!taskId) {
    const who = lead.contactName || lead.companyName || lead.email;
    const task = await salesTask.create({
      workspaceId,
      leadId: lead.id,
      title: `Log meeting outcome — ${who}`,
      type: 'post_call_outcome',
      priority: 'high',
      dueAt: untilAt,
      ownerUserId: userId,
    });
    taskId = task.id;
  } else {
    await dbUpdateTaskDue(workspaceId, taskId, untilAt);
  }
  const db = getDb();
  const [updated] = await db
    .update(calendarEvents)
    .set({ outcomeSnoozedUntil: untilAt, outcomeTaskId: taskId, updatedAt: new Date() })
    .where(eq(calendarEvents.id, event.id))
    .returning();
  if (!updated) throw new Error('snoozeOutcome: update returned no row');
  return { event: updated, taskId, pendingCount: await pendingCountForUser(workspaceId, userId, role) };
}

export async function ignoreOutcome(
  workspaceId: string,
  eventId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<{ event: CalendarEvent; pendingCount: number }> {
  const { event } = await getOutcomeEventForUser(workspaceId, eventId, userId, role);
  if (event.outcomeLoggedAt) {
    return { event, pendingCount: await pendingCountForUser(workspaceId, userId, role) };
  }
  const db = getDb();
  const [updated] = await db
    .update(calendarEvents)
    .set({
      outcomeStatus: 'ignored',
      meetingOutcome: null,
      outcomeReason: 'ignored',
      outcomeNotes: null,
      outcomeNextAction: null,
      outcomeLoggedAt: new Date(),
      outcomeLoggedByUserId: userId,
      outcomeSnoozedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(calendarEvents.id, event.id))
    .returning();
  if (!updated) throw new Error('ignoreOutcome: update returned no row');

  if (event.outcomeTaskId) {
    await salesTask.complete(workspaceId, event.outcomeTaskId, userId).catch(() => undefined);
  }

  return { event: updated, pendingCount: await pendingCountForUser(workspaceId, userId, role) };
}

async function dbUpdateTaskDue(workspaceId: string, taskId: string, dueAt: Date) {
  const db = getDb();
  await db
    .update(salesTasks)
    .set({ status: 'open', dueAt })
    .where(and(eq(salesTasks.workspaceId, workspaceId), eq(salesTasks.id, taskId)));
}

export async function endMeetingNow(
  workspaceId: string,
  eventId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<{ event: CalendarEvent; pendingCount: number }> {
  const { event } = await getOutcomeEventForUser(workspaceId, eventId, userId, role);
  const now = new Date();
  const endAt = now > event.startAt ? now : event.endAt;
  const updated = await updateEvent(workspaceId, event.id, { endAt });
  return { event: updated, pendingCount: await pendingCountForUser(workspaceId, userId, role) };
}

function extractMeetCode(meetLink: string | null): string | null {
  if (!meetLink) return null;
  const m = meetLink.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

export async function syncMeetArtifacts(
  workspaceId: string,
  eventId: string,
  opts: { userId?: string; role?: WorkspaceRole } = {},
): Promise<{ event: CalendarEvent; transcriptChars: number; notesChars: number }> {
  const row = opts.userId && opts.role
    ? await getOutcomeEventForUser(workspaceId, eventId, opts.userId, opts.role)
    : await getEventWithAccount(workspaceId, eventId);
  const { event, account, lead } = row;
  const meetCode = extractMeetCode(event.meetLink);
  if (!meetCode) {
    const updated = await setMeetArtifactState(event.id, {
      meetArtifactStatus: 'no_meet',
      meetArtifactSyncedAt: new Date(),
      meetArtifactError: null,
    });
    return { event: updated, transcriptChars: 0, notesChars: 0 };
  }

  try {
    const auth = await authClientForAccount(account);
    const artifacts = await fetchMeetArtifacts(auth, meetCode);
    const updated = await setMeetArtifactState(event.id, {
      meetConferenceRecord: artifacts.conferenceRecord,
      meetArtifactStatus: artifacts.transcriptText || artifacts.notesText ? 'synced' : 'no_artifacts',
      meetTranscriptText: artifacts.transcriptText || null,
      meetNotesText: artifacts.notesText || null,
      meetArtifactSyncedAt: new Date(),
      meetArtifactError: null,
    });
    if ((artifacts.transcriptText || artifacts.notesText) && lead && event.meetArtifactStatus !== 'synced') {
      await salesNote.create({
        workspaceId,
        leadId: lead.id,
        kind: 'post_call',
        title: `Google Meet notes · ${event.title}`,
        body: [
          artifacts.notesText ? `Notes:\n${artifacts.notesText.slice(0, 6000)}` : null,
          artifacts.transcriptText ? `Transcript excerpt:\n${artifacts.transcriptText.slice(0, 6000)}` : null,
        ].filter(Boolean).join('\n\n'),
        authorUserId: opts.userId ?? null,
      }).catch(() => undefined);
    }
    return {
      event: updated,
      transcriptChars: artifacts.transcriptText.length,
      notesChars: artifacts.notesText.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updated = await setMeetArtifactState(event.id, {
      meetArtifactStatus: 'error',
      meetArtifactSyncedAt: new Date(),
      meetArtifactError: message.slice(0, 1000),
    });
    return { event: updated, transcriptChars: 0, notesChars: 0 };
  }
}

async function getEventWithAccount(
  workspaceId: string,
  eventId: string,
): Promise<{ event: CalendarEvent; account: GmailAccount; lead: typeof leads.$inferSelect | null }> {
  const db = getDb();
  const [row] = await db
    .select({ event: calendarEvents, account: gmailAccounts, lead: leads })
    .from(calendarEvents)
    .innerJoin(gmailAccounts, eq(calendarEvents.gmailAccountId, gmailAccounts.id))
    .leftJoin(leads, eq(calendarEvents.leadId, leads.id))
    .where(and(eq(calendarEvents.workspaceId, workspaceId), eq(calendarEvents.id, eventId)))
    .limit(1);
  if (!row) throw new NotFoundError('Calendar event not found');
  return row;
}

async function setMeetArtifactState(
  eventId: string,
  patch: Partial<Pick<CalendarEvent,
    'meetConferenceRecord' | 'meetArtifactStatus' | 'meetTranscriptText' | 'meetNotesText' | 'meetArtifactSyncedAt' | 'meetArtifactError'
  >>,
): Promise<CalendarEvent> {
  const db = getDb();
  const [updated] = await db
    .update(calendarEvents)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(calendarEvents.id, eventId))
    .returning();
  if (!updated) throw new Error('setMeetArtifactState: update returned no row');
  return updated;
}

async function fetchMeetArtifacts(
  auth: Auth.OAuth2Client,
  meetCode: string,
): Promise<{ conferenceRecord: string | null; transcriptText: string; notesText: string }> {
  const meet = (google as unknown as { meet: (opts: unknown) => unknown }).meet({ version: 'v2', auth }) as {
    conferenceRecords: {
      list: (opts: { filter?: string; pageSize?: number }) => Promise<{ data: { conferenceRecords?: Array<{ name?: string }> } }>;
      transcripts: {
        list: (opts: { parent: string; pageSize?: number }) => Promise<{ data: { transcripts?: Array<{ name?: string }> } }>;
        entries: {
          list: (opts: { parent: string; pageSize?: number; pageToken?: string }) => Promise<{ data: { transcriptEntries?: Array<{ text?: string; participant?: string }>; nextPageToken?: string } }>;
        };
      };
    };
  };
  const filters = [
    `space.meeting_code = "${meetCode}"`,
    `meeting_code = "${meetCode}"`,
  ];
  let conferenceRecord: string | null = null;
  for (const filter of filters) {
    try {
      const res = await meet.conferenceRecords.list({ filter, pageSize: 1 });
      conferenceRecord = res.data.conferenceRecords?.[0]?.name ?? null;
      if (conferenceRecord) break;
    } catch {
      // Try the next documented/legacy filter spelling.
    }
  }
  if (!conferenceRecord) return { conferenceRecord: null, transcriptText: '', notesText: '' };

  let transcriptText = '';
  try {
    const transcripts = await meet.conferenceRecords.transcripts.list({
      parent: conferenceRecord,
      pageSize: 10,
    });
    const transcriptName = transcripts.data.transcripts?.[0]?.name;
    if (transcriptName) {
      let pageToken: string | undefined;
      const lines: string[] = [];
      do {
        const entries = await meet.conferenceRecords.transcripts.entries.list({
          parent: transcriptName,
          pageSize: 1000,
          pageToken,
        });
        for (const entry of entries.data.transcriptEntries ?? []) {
          if (entry.text) lines.push(entry.text);
        }
        pageToken = entries.data.nextPageToken ?? undefined;
      } while (pageToken);
      transcriptText = lines.join('\n');
    }
  } catch {
    transcriptText = '';
  }

  const notesText = await fetchMeetSmartNotes(auth, conferenceRecord).catch(() => '');
  return { conferenceRecord, transcriptText, notesText };
}

async function fetchMeetSmartNotes(auth: Auth.OAuth2Client, conferenceRecord: string): Promise<string> {
  const meetBeta = (google as unknown as { meet: (opts: unknown) => unknown }).meet({ version: 'v2beta', auth }) as {
    conferenceRecords?: {
      smartNotes?: {
        list: (opts: { parent: string; pageSize?: number }) => Promise<{ data: { smartNotes?: Array<{ document?: string; documentId?: string; name?: string }> } }>;
      };
    };
  };
  const smartNotes = await meetBeta.conferenceRecords?.smartNotes?.list({ parent: conferenceRecord, pageSize: 1 });
  const note = smartNotes?.data.smartNotes?.[0];
  const docId = note?.documentId ?? note?.document?.match(/documents\/([^/]+)/)?.[1] ?? null;
  if (!docId) return '';
  const docs = google.docs({ version: 'v1', auth });
  const doc = await docs.documents.get({ documentId: docId });
  const pieces: string[] = [];
  for (const block of doc.data.body?.content ?? []) {
    for (const el of block.paragraph?.elements ?? []) {
      const text = el.textRun?.content;
      if (text) pieces.push(text);
    }
  }
  return pieces.join('').trim();
}

export async function scanPostCallOutcomes(): Promise<number> {
  const db = getDb();
  const now = new Date();
  const rows = await db
    .select({ event: calendarEvents, account: gmailAccounts, lead: leads })
    .from(calendarEvents)
    .innerJoin(gmailAccounts, eq(calendarEvents.gmailAccountId, gmailAccounts.id))
    .leftJoin(leads, eq(calendarEvents.leadId, leads.id))
    .where(
      and(
        ...outcomeBaseFilters('', now, false).filter((_v, idx) => idx !== 0),
        isNull(calendarEvents.outcomeTaskId),
      ),
    )
    .orderBy(asc(calendarEvents.endAt))
    .limit(100);

  let created = 0;
  for (const row of rows) {
    if (!row.lead) continue;
    const ownerUserId = row.account.connectedByUserId;
    const who = row.lead.contactName || row.lead.companyName || row.lead.email;
    const task = await salesTask.create({
      workspaceId: row.event.workspaceId,
      leadId: row.lead.id,
      title: `Log meeting outcome — ${who}`,
      type: 'post_call_outcome',
      priority: 'high',
      dueAt: now,
      ownerUserId,
      source: 'manual',
    });
    await db
      .update(calendarEvents)
      .set({ outcomeTaskId: task.id, updatedAt: now })
      .where(eq(calendarEvents.id, row.event.id));
    await syncMeetArtifacts(row.event.workspaceId, row.event.id).catch(() => undefined);
    await notify.emit({
      workspaceId: row.event.workspaceId,
      userId: ownerUserId ?? null,
      leadId: row.lead.id,
      kind: 'task',
      priority: 'high',
      title: `Log meeting outcome — ${who}`,
      body: row.event.title,
      meta: row.event.endAt.toISOString(),
    });
    created++;
  }
  return created;
}

/**
 * AI-driven booking: a lead's reply asked to schedule a call. Create a
 * tentative event with a Meet link, linked to the lead + thread.
 * Returns the event and the Meet link (to drop into the AI's draft reply).
 */
export async function bookMeetingFromReply(input: {
  workspaceId: string;
  leadId: string;
  campaignId?: string | null;
  emailThreadId?: string | null;
  proposedTime?: Date;
  durationMinutes?: number;
}): Promise<{ event: CalendarEvent; meetLink: string | null }> {
  const db = getDb();
  const leadRows = await db
    .select()
    .from(leads)
    .where(and(eq(leads.workspaceId, input.workspaceId), eq(leads.id, input.leadId)))
    .limit(1);
  const lead = leadRows[0];
  if (!lead) throw new NotFoundError('Lead not found');

  const cfg = await getCalendarConfig(input.workspaceId);
  // A proposedTime is an exact slot the lead picked — book it as-is. With no
  // proposed time, fall back to the next round hour, ~24h out.
  let start: Date;
  if (input.proposedTime) {
    start = new Date(input.proposedTime);
  } else {
    start = new Date(Date.now() + 24 * 3_600_000);
    start.setMinutes(0, 0, 0);
  }
  const end = new Date(
    start.getTime() + (input.durationMinutes ?? cfg.meetingDurationMinutes) * 60_000,
  );

  const who = lead.contactName || lead.companyName || lead.email;
  const event = await createEvent(input.workspaceId, {
    title: `Intro call · ${who}`,
    description: `Auto-booked from an email reply. Lead: ${lead.email}`,
    startAt: start,
    endAt: end,
    attendees: [{ email: lead.email, name: lead.contactName ?? undefined }],
    leadId: input.leadId,
    campaignId: input.campaignId ?? lead.campaignId ?? null,
    emailThreadId: input.emailThreadId ?? null,
    withMeet: true,
    source: 'ai_booked',
  });

  // Notify the operator that the AI booked a meeting (mobile Alerts + push).
  await notify.emit({
    workspaceId: input.workspaceId,
    leadId: input.leadId,
    kind: 'booking',
    priority: 'high',
    title: `Meeting booked — ${who}`,
    body: `${start.toLocaleString()} · ${lead.email}`,
  });

  return { event, meetLink: event.meetLink };
}

// ===========================================================================
// Scheduling config + availability engine
// ===========================================================================

/** Used when a workspace has no calendar_config saved yet. */
export const DEFAULT_CALENDAR_CONFIG: CalendarConfig = {
  timezone: 'America/New_York',
  workingDays: [1, 2, 3, 4, 5],
  workingHours: { start: '09:00', end: '17:00' },
  meetingDurationMinutes: 30,
  slotIntervalMinutes: 30,
  minLeadTimeHours: 12,
  slotsNextDay: 2,
  slotsDayAfter: 1,
  blockedWindows: [
    { id: 'default-block', label: 'Unavailable', days: [1, 2, 3, 4, 5], start: '14:00', end: '16:00' },
  ],
};

/** Load a workspace's calendar config, merged over the defaults. */
export async function getCalendarConfig(workspaceId: string): Promise<CalendarConfig> {
  const db = getDb();
  const rows = await db
    .select({ cfg: workspaces.calendarConfig })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const stored = rows[0]?.cfg;
  if (!stored) return DEFAULT_CALENDAR_CONFIG;
  return {
    ...DEFAULT_CALENDAR_CONFIG,
    ...stored,
    workingHours: { ...DEFAULT_CALENDAR_CONFIG.workingHours, ...(stored.workingHours ?? {}) },
    workingDays: stored.workingDays ?? DEFAULT_CALENDAR_CONFIG.workingDays,
    blockedWindows: stored.blockedWindows ?? DEFAULT_CALENDAR_CONFIG.blockedWindows,
  };
}

// ---- timezone helpers (no external dependency) ----

const WEEKDAY_NUM: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function tzParts(date: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value;
  return {
    year: Number(m.year),
    month: Number(m.month),
    day: Number(m.day),
    hour: Number(m.hour) % 24,
    minute: Number(m.minute),
    second: Number(m.second),
    weekday: WEEKDAY_NUM[m.weekday ?? 'Sun'] ?? 0,
  };
}

function tzOffsetMs(date: Date, timeZone: string): number {
  const p = tzParts(date, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - date.getTime();
}

/** A wall-clock time in `timeZone` (month 0-indexed) → the corresponding UTC Date. */
function zonedToUtc(y: number, m0: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const naive = Date.UTC(y, m0, d, hh, mm);
  let offset = tzOffsetMs(new Date(naive), timeZone);
  offset = tzOffsetMs(new Date(naive - offset), timeZone);
  return new Date(naive - offset);
}

function parseHHMM(s: string): { h: number; m: number } {
  const parts = (s ?? '').split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  return { h: Number.isFinite(h) ? h : 0, m: Number.isFinite(m) ? m : 0 };
}

/** Add `add` calendar days to a y/m0/d date, normalising month/year rollover. */
function addDaysCal(y: number, m0: number, d: number, add: number) {
  const dt = new Date(Date.UTC(y, m0, d + add, 12));
  return { y: dt.getUTCFullYear(), m0: dt.getUTCMonth(), d: dt.getUTCDate(), wd: dt.getUTCDay() };
}

/** Format an instant as a human label in the given timezone, e.g. "Tue, May 27, 10:00 AM EDT". */
export function formatSlotLabel(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).format(d);
}

export interface MeetingSlot {
  start: string; // ISO 8601
  end: string; // ISO 8601
  label: string; // human, in the config timezone
}

/**
 * Compute concrete open meeting slots from the operator's real Google Calendar
 * free/busy, working hours, and blocked windows. Returns slotsNextDay slots on
 * the next working day and slotsDayAfter on the working day after.
 */
export async function computeAvailableSlots(
  workspaceId: string,
  opts: { gmailAccountId?: string } = {},
): Promise<{ slots: MeetingSlot[]; config: CalendarConfig }> {
  const cfg = await getCalendarConfig(workspaceId);
  const tz = cfg.timezone;
  const now = new Date();
  const earliest = now.getTime() + cfg.minLeadTimeHours * 3_600_000;

  // The next two working days strictly after today (in the config timezone).
  const today = tzParts(now, tz);
  const targetDays: { y: number; m0: number; d: number; wd: number }[] = [];
  for (let i = 1; i <= 21 && targetDays.length < 2; i++) {
    const cal = addDaysCal(today.year, today.month - 1, today.day, i);
    if (cfg.workingDays.includes(cal.wd)) targetDays.push(cal);
  }
  if (targetDays.length === 0) return { slots: [], config: cfg };

  const wh = parseHHMM(cfg.workingHours.start);
  const we = parseHHMM(cfg.workingHours.end);
  const firstDay = targetDays[0]!;
  const lastDay = targetDays[targetDays.length - 1]!;
  const queryMin = zonedToUtc(firstDay.y, firstDay.m0, firstDay.d, wh.h, wh.m, tz);
  const queryMax = zonedToUtc(lastDay.y, lastDay.m0, lastDay.d, we.h, we.m, tz);

  // Pull busy intervals from Google Calendar (best-effort).
  let busy: { start: number; end: number }[] = [];
  try {
    const account = await resolveAccount(workspaceId, opts.gmailAccountId);
    const auth = await authClientForAccount(account);
    const cal = calendarClient(auth);
    const fb = await cal.freebusy.query({
      requestBody: {
        timeMin: queryMin.toISOString(),
        timeMax: queryMax.toISOString(),
        items: [{ id: 'primary' }],
      },
    });
    busy = (fb.data.calendars?.primary?.busy ?? [])
      .filter((b) => b.start && b.end)
      .map((b) => ({ start: new Date(b.start!).getTime(), end: new Date(b.end!).getTime() }));
  } catch {
    // No calendar / API error — fall back to working-hours + blocked-windows only.
  }

  const durationMs = cfg.meetingDurationMinutes * 60_000;
  const perDay = [cfg.slotsNextDay, cfg.slotsDayAfter];
  const slots: MeetingSlot[] = [];

  for (let di = 0; di < targetDays.length; di++) {
    const day = targetDays[di]!;
    const want = perDay[di] ?? 0;
    if (want <= 0) continue;

    const blocks = cfg.blockedWindows
      .filter((b) => b.days.includes(day.wd))
      .map((b) => {
        const bs = parseHHMM(b.start);
        const be = parseHHMM(b.end);
        return {
          start: zonedToUtc(day.y, day.m0, day.d, bs.h, bs.m, tz).getTime(),
          end: zonedToUtc(day.y, day.m0, day.d, be.h, be.m, tz).getTime(),
        };
      });

    const dayStart = zonedToUtc(day.y, day.m0, day.d, wh.h, wh.m, tz).getTime();
    const dayEnd = zonedToUtc(day.y, day.m0, day.d, we.h, we.m, tz).getTime();
    const step = cfg.slotIntervalMinutes * 60_000;

    let added = 0;
    for (let s = dayStart; s + durationMs <= dayEnd && added < want; s += step) {
      const e = s + durationMs;
      if (s < earliest) continue;
      const overlaps = (iv: { start: number; end: number }) => s < iv.end && e > iv.start;
      if (blocks.some(overlaps)) continue;
      if (busy.some(overlaps)) continue;
      slots.push({
        start: new Date(s).toISOString(),
        end: new Date(e).toISOString(),
        label: formatSlotLabel(new Date(s), tz),
      });
      added++;
    }
  }
  return { slots, config: cfg };
}

/**
 * Synchronous check: is `start` a bookable meeting time — inside working hours,
 * on a working day, and clear of every blocked window? Used to validate a time
 * a lead picked before booking it.
 */
export function isWithinBookableHours(start: Date, cfg: CalendarConfig): boolean {
  if (Number.isNaN(start.getTime())) return false;
  const tz = cfg.timezone;
  const p = tzParts(start, tz);
  if (!cfg.workingDays.includes(p.weekday)) return false;

  const end = new Date(start.getTime() + cfg.meetingDurationMinutes * 60_000);
  const wh = parseHHMM(cfg.workingHours.start);
  const we = parseHHMM(cfg.workingHours.end);
  const dayStart = zonedToUtc(p.year, p.month - 1, p.day, wh.h, wh.m, tz).getTime();
  const dayEnd = zonedToUtc(p.year, p.month - 1, p.day, we.h, we.m, tz).getTime();
  if (start.getTime() < dayStart || end.getTime() > dayEnd) return false;

  for (const b of cfg.blockedWindows) {
    if (!b.days.includes(p.weekday)) continue;
    const bs = parseHHMM(b.start);
    const be = parseHHMM(b.end);
    const bStart = zonedToUtc(p.year, p.month - 1, p.day, bs.h, bs.m, tz).getTime();
    const bEnd = zonedToUtc(p.year, p.month - 1, p.day, be.h, be.m, tz).getTime();
    if (start.getTime() < bEnd && end.getTime() > bStart) return false;
  }
  return true;
}
