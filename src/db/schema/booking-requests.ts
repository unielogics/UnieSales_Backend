import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';
import { bookingPages } from './booking-pages';

// A submission from the public /book/<slug> form. Captures the guest's
// contact info, multi-select interests (products + topics), and a free-form
// "preferred time" string for v1. Real slot/availability lives in a later
// phase — this is the simplest possible "they want to talk, here's why"
// record.
//
// Status starts at 'pending'. Operator confirms → 'confirmed'; declines →
// 'declined'; held call → 'completed'.
export const bookingRequests = pgTable(
  'booking_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingPageId: uuid('booking_page_id').notNull().references(() => bookingPages.id),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),

    guestName: text('guest_name').notNull(),
    guestEmail: text('guest_email').notNull(),
    guestCompany: text('guest_company'),
    guestPhone: text('guest_phone'),

    productsOfInterest: jsonb('products_of_interest').$type<string[]>().notNull().default([]),
    topics: jsonb('topics').$type<string[]>().notNull().default([]),

    // Free-form fallback (e.g. "Tuesday 2pm EST"). Still accepted as a
    // hand-typed comment, but the calendar picker now provides the structured
    // slot below.
    preferredTime: text('preferred_time'),
    notes: text('notes'),

    // ── Calendar slot ───────────────────────────────────────────────────
    // The exact UTC instant the visitor picked. Null on legacy / free-form
    // submissions. Used to populate the calendar invite when the operator
    // confirms.
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    // The slot's "wall clock" key in the booking page's timezone, e.g.
    // "2026-05-28T14:00". Used as a deterministic dedup key so two visitors
    // can't grab the same slot. Indexed for the availability lookup.
    slotKey: text('slot_key'),

    status: text('status').notNull().default('pending'),

    sourceUrl: text('source_url'),
    clientIp: text('client_ip'),
    userAgent: text('user_agent'),
    meta: jsonb('meta').notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: false }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: false }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceCreatedIdx: index('booking_requests_workspace_created_idx').on(
      t.workspaceId,
      t.createdAt,
    ),
    pageCreatedIdx: index('booking_requests_page_created_idx').on(t.bookingPageId, t.createdAt),
    workspaceStatusIdx: index('booking_requests_workspace_status_idx').on(t.workspaceId, t.status),
    // Speeds up the "is this slot taken?" lookup during availability calls.
    pageSlotIdx: index('booking_requests_page_slot_idx').on(t.bookingPageId, t.slotKey),
  }),
);

export type BookingRequest = typeof bookingRequests.$inferSelect;
export type NewBookingRequest = typeof bookingRequests.$inferInsert;

export const BOOKING_REQUEST_STATUSES = ['pending', 'confirmed', 'declined', 'completed'] as const;
export type BookingRequestStatus = (typeof BOOKING_REQUEST_STATUSES)[number];
