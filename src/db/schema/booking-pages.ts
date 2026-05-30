import { pgTable, uuid, text, jsonb, boolean, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { users } from './users';

/**
 * Per-weekday window of available time. Weekday is 0=Sunday … 6=Saturday
 * (matches JS `Date.getDay()`). `start`/`end` are 24h "HH:MM" strings in
 * the page's IANA timezone. Multiple ranges per weekday are allowed (e.g.
 * morning + afternoon with a lunch break).
 */
export interface WorkingHoursRange {
  weekday: number; // 0-6
  start: string; // "09:00"
  end: string; // "17:00"
}

// Default = Mon-Fri 9am-5pm.
export const DEFAULT_WORKING_HOURS: WorkingHoursRange[] = [
  { weekday: 1, start: '09:00', end: '17:00' },
  { weekday: 2, start: '09:00', end: '17:00' },
  { weekday: 3, start: '09:00', end: '17:00' },
  { weekday: 4, start: '09:00', end: '17:00' },
  { weekday: 5, start: '09:00', end: '17:00' },
];

// One bookable landing page per user. Shareable at `/book/<slug>`. The
// owner picks a workspace where booking_requests should land — usually
// their personal Inbound workspace, but could be any workspace they own.
//
// `products` and `topics` are arbitrary string arrays the owner configures.
// They show up as multi-select chips on the public form so guests can tell
// the operator what they're interested in and what they want to discuss.
export const bookingPages = pgTable(
  'booking_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),

    // URL slug — e.g. 'franco' makes the public page /book/franco.
    slug: text('slug').notNull(),

    title: text('title').notNull(),
    intro: text('intro'),

    // Multi-select option lists the public form shows. Plain string arrays so
    // the owner can edit them from Settings without touching code.
    products: jsonb('products').$type<string[]>().notNull().default([]),
    topics: jsonb('topics').$type<string[]>().notNull().default([]),

    isActive: boolean('is_active').notNull().default(true),

    // ── Availability ────────────────────────────────────────────────────
    // IANA timezone the working_hours below are interpreted in. Defaults to
    // America/New_York which matches Franco's working hours.
    timezone: text('timezone').notNull().default('America/New_York'),
    // Slot length in minutes.
    durationMinutes: integer('duration_minutes').notNull().default(30),
    // Padding between meetings (added to slot length when stepping).
    bufferMinutes: integer('buffer_minutes').notNull().default(0),
    // How many days forward to expose slots.
    daysIntoFuture: integer('days_into_future').notNull().default(14),
    // Earliest acceptable booking, expressed as hours from "now".
    minLeadHours: integer('min_lead_hours').notNull().default(4),
    // Weekly recurring availability. Multiple ranges per weekday allowed.
    workingHours: jsonb('working_hours').$type<WorkingHoursRange[]>().notNull().default(DEFAULT_WORKING_HOURS),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueSlug: uniqueIndex('booking_pages_slug_unique').on(t.slug),
    // One booking page per user — keeps the URL space simple in v1. Operators
    // can iterate the same page rather than juggle multiple variants.
    uniquePerUser: uniqueIndex('booking_pages_user_unique').on(t.userId),
  }),
);

export type BookingPage = typeof bookingPages.$inferSelect;
export type NewBookingPage = typeof bookingPages.$inferInsert;
