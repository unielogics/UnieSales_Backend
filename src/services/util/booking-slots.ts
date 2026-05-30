/**
 * Booking slot generation + timezone helpers.
 *
 * The booking page stores availability in the *operator's* IANA timezone
 * (e.g. "America/New_York") because that's how a human reasons about
 * working hours. Visitors anywhere on the planet pick a slot; we keep the
 * canonical UTC instant + a stable "slot key" (the local YYYY-MM-DDTHH:MM
 * string in the operator's tz) so we can dedupe without dealing with DST
 * gotchas on every lookup.
 */
import type { WorkingHoursRange } from '../../db/schema/booking-pages';

export interface SlotDescriptor {
  /** The operator-local wall clock date — YYYY-MM-DD. */
  date: string;
  /** The operator-local wall clock time — HH:MM (24h). */
  time: string;
  /** Composite key — `${date}T${time}` in operator tz. Used to dedupe. */
  key: string;
  /** Absolute UTC instant (ISO-8601) of the slot start. */
  startUtc: string;
  /** Absolute UTC instant (ISO-8601) of the slot end. */
  endUtc: string;
  /** Human label rendered to the visitor in their local read of operator tz. */
  label: string;
}

export interface DayBucket {
  date: string; // YYYY-MM-DD (operator tz)
  weekday: number; // 0-6
  /** Operator-tz long date label, e.g. "Wed, May 28". */
  label: string;
  /** "May" / "Jun" etc. for the calendar header. */
  monthLabel: string;
  /** 1-31. */
  day: number;
  /** True if at least one slot is bookable. */
  hasSlots: boolean;
  slots: SlotDescriptor[];
}

export interface AvailabilityInput {
  timezone: string;
  durationMinutes: number;
  bufferMinutes: number;
  minLeadHours: number;
  daysIntoFuture: number;
  workingHours: WorkingHoursRange[];
  /** Slot keys already taken (booking_requests with active status). */
  takenSlotKeys: ReadonlySet<string>;
  /** Override "now" — handy for tests. */
  now?: Date;
}

/**
 * Build the list of bookable day buckets for the visitor.
 *
 * Algorithm:
 *   - For each calendar day in [today, today + daysIntoFuture] (operator tz)
 *   - Look up working_hours where weekday matches
 *   - Walk start → end in (duration + buffer) minute steps
 *   - Skip slots earlier than now + minLeadHours
 *   - Skip slots whose key is already in takenSlotKeys
 *   - Skip ranges in the past
 */
export function generateAvailability(input: AvailabilityInput): DayBucket[] {
  const {
    timezone,
    durationMinutes,
    bufferMinutes,
    minLeadHours,
    daysIntoFuture,
    workingHours,
    takenSlotKeys,
    now = new Date(),
  } = input;

  const step = Math.max(15, durationMinutes + bufferMinutes);
  const earliestUtcMs = now.getTime() + minLeadHours * 60 * 60 * 1000;
  const hoursByDay = new Map<number, WorkingHoursRange[]>();
  for (const w of workingHours) {
    const list = hoursByDay.get(w.weekday) ?? [];
    list.push(w);
    hoursByDay.set(w.weekday, list);
  }

  const buckets: DayBucket[] = [];
  // Walk forward day-by-day in operator-local calendar days.
  for (let i = 0; i < daysIntoFuture; i++) {
    const day = addDaysInTz(now, i, timezone);
    const wd = weekdayInTz(day, timezone);
    const ranges = hoursByDay.get(wd) ?? [];
    const dateStr = formatYmdInTz(day, timezone);
    const slots: SlotDescriptor[] = [];

    for (const r of ranges) {
      const startMin = hhmmToMinutes(r.start);
      const endMin = hhmmToMinutes(r.end);
      if (endMin <= startMin) continue;
      for (let m = startMin; m + durationMinutes <= endMin; m += step) {
        const hh = pad2(Math.floor(m / 60));
        const mm = pad2(m % 60);
        const time = `${hh}:${mm}`;
        const key = `${dateStr}T${time}`;
        if (takenSlotKeys.has(key)) continue;
        // Convert this local wall-clock to UTC.
        const startUtc = localToUtc(dateStr, time, timezone);
        if (!startUtc) continue;
        if (startUtc.getTime() < earliestUtcMs) continue;
        const endUtc = new Date(startUtc.getTime() + durationMinutes * 60 * 1000);
        slots.push({
          date: dateStr,
          time,
          key,
          startUtc: startUtc.toISOString(),
          endUtc: endUtc.toISOString(),
          label: formatTimeLabel(hh, mm),
        });
      }
    }

    buckets.push({
      date: dateStr,
      weekday: wd,
      label: formatDayLabel(day, timezone),
      monthLabel: formatMonthShortInTz(day, timezone),
      day: dayOfMonthInTz(day, timezone),
      hasSlots: slots.length > 0,
      slots,
    });
  }
  return buckets;
}

/**
 * Convert a wall-clock "YYYY-MM-DD" + "HH:MM" in `tz` to the corresponding
 * UTC instant. Iterative two-pass because we don't want to ship a tz lib;
 * `Intl.DateTimeFormat` gives us the offset we need to invert. Converges in
 * ≤2 iterations for non-DST-transition slots.
 */
export function localToUtc(dateYmd: string, timeHhMm: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd);
  const t = /^(\d{2}):(\d{2})$/.exec(timeHhMm);
  if (!m || !t) return null;
  const targetWall = `${dateYmd}T${timeHhMm}:00`;
  const targetWallMs = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(t[1]),
    Number(t[2]),
    0,
  );
  // First guess: assume tz === UTC. Then look at the wall clock the tz
  // actually shows for that instant, compute the offset, and shift.
  let guessMs = targetWallMs;
  for (let i = 0; i < 4; i++) {
    const wallSeenMs = readWallClockMs(new Date(guessMs), tz);
    const diff = targetWallMs - wallSeenMs;
    if (diff === 0) break;
    guessMs += diff;
  }
  return new Date(guessMs);
}

/** Reads `d` formatted in `tz` and returns the UTC-as-if-local ms. */
function readWallClockMs(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === '24' ? '00' : map.hour;
  return Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(hour),
    Number(map.minute),
    Number(map.second),
  );
}

function addDaysInTz(base: Date, days: number, tz: string): Date {
  // Compute today's "noon" in the tz, then add days. Noon avoids DST
  // wraparound at midnight in tz's that change during the day.
  const todayYmd = formatYmdInTz(base, tz);
  const noon = localToUtc(todayYmd, '12:00', tz);
  if (!noon) return base;
  return new Date(noon.getTime() + days * 24 * 60 * 60 * 1000);
}

function weekdayInTz(d: Date, tz: string): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[wd] ?? 0;
}

function formatYmdInTz(d: Date, tz: string): string {
  // en-CA gives "YYYY-MM-DD" natively.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function dayOfMonthInTz(d: Date, tz: string): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric' }).format(d),
  );
}

function formatMonthShortInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short' }).format(d);
}

function formatDayLabel(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

function formatTimeLabel(hh: string, mm: string): string {
  // Owner-tz local label rendered 12h, e.g. "2:00 PM".
  const h = Number(hh);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${suffix}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Helper for the public submit path — given a date + time + tz, compute the slot key + UTC instant. */
export function buildSlotKey(date: string, time: string): string {
  return `${date}T${time}`;
}
