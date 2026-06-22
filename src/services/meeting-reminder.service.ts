import { and, eq, gt, lte } from 'drizzle-orm';
import { getDb } from '../config/db';
import { bookingRequests, type BookingRequest } from '../db/schema/booking-requests';
import { calendarEvents } from '../db/schema/calendar-events';
import { sendEmail } from './gmail.service';
import * as notify from './notification.service';

const HOUR_MS = 60 * 60 * 1000;
const BATCH = 100;

type ReminderKind = '24h' | '1h';

export async function scanMeetingReminders(): Promise<{
  guest24h: number;
  guest1h: number;
  operator30m: number;
}> {
  const db = getDb();
  const now = new Date();
  const horizon = new Date(now.getTime() + 24 * HOUR_MS);

  const bookings = await db
    .select()
    .from(bookingRequests)
    .where(
      and(
        eq(bookingRequests.status, 'confirmed'),
        gt(bookingRequests.scheduledAt, now),
        lte(bookingRequests.scheduledAt, horizon),
      ),
    )
    .limit(BATCH);

  let guest24h = 0;
  let guest1h = 0;
  let operator30m = 0;

  for (const booking of bookings) {
    if (!booking.scheduledAt) continue;
    const meta = metaRecord(booking.meta);
    const msUntil = booking.scheduledAt.getTime() - now.getTime();

    if (msUntil <= 24 * HOUR_MS && !meta.reminder24hSentAt) {
      if (await sendGuestReminder(booking, '24h')) guest24h += 1;
    }
    if (msUntil <= HOUR_MS && !meta.reminder1hSentAt) {
      if (await sendGuestReminder(booking, '1h')) guest1h += 1;
    }
    if (msUntil <= 30 * 60_000 && !meta.operatorReminder30mSentAt) {
      await notify.emit({
        workspaceId: booking.workspaceId,
        leadId: typeof meta.leadId === 'string' ? meta.leadId : null,
        kind: 'task',
        priority: 'high',
        title: `Meeting in 30 minutes — ${booking.guestName}`,
        body: [
          booking.guestEmail,
          formatMeetingTime(booking.scheduledAt),
          typeof meta.meetLink === 'string' ? meta.meetLink : null,
        ].filter(Boolean).join(' · '),
      });
      await markSent(booking, { operatorReminder30mSentAt: new Date().toISOString() });
      operator30m += 1;
    }
  }

  return { guest24h, guest1h, operator30m };
}

async function sendGuestReminder(booking: BookingRequest, kind: ReminderKind): Promise<boolean> {
  const meta = metaRecord(booking.meta);
  const gmailAccountId = await resolveGmailAccountId(booking);
  if (!gmailAccountId || !booking.scheduledAt) return false;

  const when = formatMeetingTime(booking.scheduledAt);
  const meetLink = typeof meta.meetLink === 'string' ? meta.meetLink : null;
  const label = kind === '24h' ? 'tomorrow' : 'in about an hour';
  const body = [
    `Hi ${firstName(booking.guestName)},`,
    '',
    `Quick reminder that your UnieSales meeting is ${label}: ${when}.`,
    meetLink ? `Google Meet: ${meetLink}` : null,
    '',
    'Talk soon,',
    'UnieSales',
  ].filter((x): x is string => x != null).join('\n');

  try {
    await sendEmail({
      workspaceId: booking.workspaceId,
      gmailAccountId,
      to: booking.guestEmail,
      subject: kind === '24h' ? `Reminder: meeting tomorrow` : `Reminder: meeting soon`,
      body,
      leadId: typeof meta.leadId === 'string' ? meta.leadId : undefined,
      bypassHealthGate: true,
      bypassDailyLimit: true,
    });
    await markSent(
      booking,
      kind === '24h'
        ? { reminder24hSentAt: new Date().toISOString() }
        : { reminder1hSentAt: new Date().toISOString() },
    );
    return true;
  } catch (err) {
    await notify.emit({
      workspaceId: booking.workspaceId,
      leadId: typeof meta.leadId === 'string' ? meta.leadId : null,
      kind: 'task',
      priority: 'high',
      title: `Meeting reminder email failed — ${booking.guestName}`,
      body: err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240),
    });
    return false;
  }
}

async function resolveGmailAccountId(booking: BookingRequest): Promise<string | null> {
  const meta = metaRecord(booking.meta);
  if (typeof meta.gmailAccountId === 'string') return meta.gmailAccountId;
  if (typeof meta.calendarEventId !== 'string') return null;
  const db = getDb();
  const [event] = await db
    .select({ gmailAccountId: calendarEvents.gmailAccountId })
    .from(calendarEvents)
    .where(eq(calendarEvents.id, meta.calendarEventId))
    .limit(1);
  return event?.gmailAccountId ?? null;
}

async function markSent(booking: BookingRequest, patch: Record<string, string>): Promise<void> {
  const db = getDb();
  await db
    .update(bookingRequests)
    .set({
      meta: { ...metaRecord(booking.meta), ...patch },
      updatedAt: new Date(),
    })
    .where(eq(bookingRequests.id, booking.id));
}

function metaRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function formatMeetingTime(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}
