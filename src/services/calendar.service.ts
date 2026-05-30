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
import { and, between, desc, eq, inArray, ne } from 'drizzle-orm';
import { google, type Auth } from 'googleapis';
import { getDb } from '../config/db';
import { calendarEvents, type CalendarEvent, type CalendarAttendee } from '../db/schema/calendar-events';
import { gmailAccounts, type GmailAccount } from '../db/schema/gmail-accounts';
import { leads } from '../db/schema/leads';
import { workspaces, type CalendarConfig } from '../db/schema/workspaces';
import { ConflictError, NotFoundError } from '../utils/errors';
import { authClientForAccount, getAccount } from './gmail.service';
import * as notify from './notification.service';

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

  const res = await cal.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  });

  const db = getDb();
  let synced = 0;
  for (const ev of res.data.items ?? []) {
    if (!ev.id) continue;
    const startAt = toDate(ev.start);
    const endAt = toDate(ev.end);
    if (!startAt || !endAt) continue;

    const attendees: CalendarAttendee[] = (ev.attendees ?? []).map((a) => ({
      email: a.email ?? '',
      name: a.displayName ?? undefined,
      responseStatus: a.responseStatus ?? undefined,
    }));

    await db
      .insert(calendarEvents)
      .values({
        workspaceId,
        gmailAccountId: account.id,
        googleEventId: ev.id,
        googleCalendarId: 'primary',
        title: ev.summary ?? '(no title)',
        description: ev.description ?? null,
        startAt,
        endAt,
        attendees,
        meetLink: extractMeetLink(ev),
        location: ev.location ?? null,
        status: ev.status === 'cancelled' ? 'cancelled' : 'confirmed',
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
          meetLink: extractMeetLink(ev),
          location: ev.location ?? null,
          status: ev.status === 'cancelled' ? 'cancelled' : 'confirmed',
          updatedAt: new Date(),
        },
      });
    synced++;
  }
  return { synced };
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
      leadId: input.leadId ?? null,
      campaignId: input.campaignId ?? null,
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
