/**
 * Booking-page service.
 *
 * Each user has at most one booking_pages row (unique constraint on user_id).
 * The owner edits products + topics there; the public form at /book/<slug>
 * reads from it and writes booking_requests rows tagged with the page's
 * workspace_id.
 *
 * Surfaces:
 *  - getByUser(userId)     → owner editing
 *  - upsertForUser(userId, patch) → owner saving changes
 *  - getPublicBySlug(slug) → renders the public form (returns nothing if disabled)
 *  - createRequest(...)    → public POST handler
 *  - listRequests(...)     → Sales Bookings view
 *  - setRequestStatus(...) → operator confirms / declines
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import {
  bookingPages,
  DEFAULT_WORKING_HOURS,
  type BookingPage,
  type NewBookingPage,
  type WorkingHoursRange,
} from '../db/schema/booking-pages';
import {
  bookingRequests,
  type BookingRequest,
  type NewBookingRequest,
  type BookingRequestStatus,
} from '../db/schema/booking-requests';
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors';
import {
  buildSlotKey,
  generateAvailability,
  localToUtc,
  type DayBucket,
} from './util/booking-slots';

// Default option lists for a brand-new booking page. The owner can edit
// these from Settings at any time. Kept here (not seeded in SQL) so the
// defaults can evolve with the product without a migration.
const DEFAULT_PRODUCTS = ['WMS', 'OMS', 'AI / Cortex', 'Implementation', 'Integration', 'Other'];
const DEFAULT_TOPICS = [
  'Carrier audit',
  'Rate optimization',
  'Warehouse audit',
  'Seller P&L audit',
  'AI workflow',
  'Pricing',
  'Implementation timeline',
  'Other',
];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,49}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export async function getByUser(userId: string): Promise<BookingPage | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(bookingPages)
    .where(eq(bookingPages.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export interface UpsertInput {
  slug?: string;
  title?: string;
  intro?: string | null;
  products?: string[];
  topics?: string[];
  isActive?: boolean;
  workspaceId?: string;
  // ── Availability ─────────────────────────────────────────────────────
  timezone?: string;
  durationMinutes?: number;
  bufferMinutes?: number;
  daysIntoFuture?: number;
  minLeadHours?: number;
  workingHours?: WorkingHoursRange[];
}

/**
 * Create-or-update the caller's one booking page. Defaults the products +
 * topics lists on first create. Slug uniqueness is enforced at the DB level.
 */
export async function upsertForUser(
  userId: string,
  defaultWorkspaceId: string,
  defaultSlug: string,
  defaultTitle: string,
  patch: UpsertInput,
): Promise<BookingPage> {
  if (patch.slug != null && !isValidSlug(patch.slug)) {
    throw new ValidationError('Invalid slug', [
      { field: 'slug', reason: 'lowercase letters, digits, and dashes only (2–50 chars, must start alphanumeric)' },
    ]);
  }
  const db = getDb();
  const existing = await getByUser(userId);
  if (existing) {
    const next = {
      ...(patch.slug != null ? { slug: patch.slug } : {}),
      ...(patch.title != null ? { title: patch.title } : {}),
      ...(patch.intro !== undefined ? { intro: patch.intro } : {}),
      ...(patch.products != null ? { products: patch.products } : {}),
      ...(patch.topics != null ? { topics: patch.topics } : {}),
      ...(patch.isActive != null ? { isActive: patch.isActive } : {}),
      ...(patch.workspaceId != null ? { workspaceId: patch.workspaceId } : {}),
      ...(patch.timezone != null ? { timezone: patch.timezone } : {}),
      ...(patch.durationMinutes != null ? { durationMinutes: patch.durationMinutes } : {}),
      ...(patch.bufferMinutes != null ? { bufferMinutes: patch.bufferMinutes } : {}),
      ...(patch.daysIntoFuture != null ? { daysIntoFuture: patch.daysIntoFuture } : {}),
      ...(patch.minLeadHours != null ? { minLeadHours: patch.minLeadHours } : {}),
      ...(patch.workingHours != null ? { workingHours: patch.workingHours } : {}),
      updatedAt: new Date(),
    };
    if (Object.keys(next).length === 1) return existing;
    try {
      const [updated] = await db
        .update(bookingPages)
        .set(next)
        .where(eq(bookingPages.id, existing.id))
        .returning();
      return updated!;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('Slug already taken', [
          { field: 'slug', reason: 'pick another' },
        ]);
      }
      throw err;
    }
  }
  // Create
  const insert: NewBookingPage = {
    userId,
    workspaceId: patch.workspaceId ?? defaultWorkspaceId,
    slug: patch.slug ?? defaultSlug,
    title: patch.title ?? defaultTitle,
    intro: patch.intro ?? null,
    products: patch.products ?? DEFAULT_PRODUCTS,
    topics: patch.topics ?? DEFAULT_TOPICS,
    isActive: patch.isActive ?? true,
    ...(patch.timezone != null ? { timezone: patch.timezone } : {}),
    ...(patch.durationMinutes != null ? { durationMinutes: patch.durationMinutes } : {}),
    ...(patch.bufferMinutes != null ? { bufferMinutes: patch.bufferMinutes } : {}),
    ...(patch.daysIntoFuture != null ? { daysIntoFuture: patch.daysIntoFuture } : {}),
    ...(patch.minLeadHours != null ? { minLeadHours: patch.minLeadHours } : {}),
    ...(patch.workingHours != null ? { workingHours: patch.workingHours } : {}),
  };
  if (!isValidSlug(insert.slug)) {
    throw new ValidationError('Invalid default slug', [{ field: 'slug', reason: 'invalid' }]);
  }
  try {
    const [created] = await db.insert(bookingPages).values(insert).returning();
    return created!;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new ConflictError('Slug already taken (or page already exists)', []);
    }
    throw err;
  }
}

/**
 * Public-form lookup. Returns null when the slug is unknown or the page is
 * deactivated — the route translates that to a 404 for the visitor.
 */
export async function getPublicBySlug(slug: string): Promise<BookingPage | null> {
  if (!isValidSlug(slug)) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(bookingPages)
    .where(and(eq(bookingPages.slug, slug), eq(bookingPages.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Look up which slots are already claimed for a booking page, then run the
 * pure slot generator with the operator's availability config. Returns a
 * weekday-grouped list the visitor's calendar UI can render directly.
 */
export async function listAvailability(page: BookingPage): Promise<{
  timezone: string;
  durationMinutes: number;
  days: DayBucket[];
}> {
  const db = getDb();
  // We treat both pending + confirmed requests as taken so two visitors
  // never end up holding the same slot. Operator declining a request frees
  // the slot back up.
  const taken = await db
    .select({ slotKey: bookingRequests.slotKey })
    .from(bookingRequests)
    .where(
      and(
        eq(bookingRequests.bookingPageId, page.id),
        inArray(bookingRequests.status, ['pending', 'confirmed']),
      ),
    );
  const takenSlotKeys = new Set<string>();
  for (const row of taken) {
    if (row.slotKey) takenSlotKeys.add(row.slotKey);
  }
  const days = generateAvailability({
    timezone: page.timezone,
    durationMinutes: page.durationMinutes,
    bufferMinutes: page.bufferMinutes,
    minLeadHours: page.minLeadHours,
    daysIntoFuture: page.daysIntoFuture,
    workingHours: page.workingHours?.length ? page.workingHours : DEFAULT_WORKING_HOURS,
    takenSlotKeys,
  });
  return {
    timezone: page.timezone,
    durationMinutes: page.durationMinutes,
    days,
  };
}

export interface CreateRequestInput {
  guestName: string;
  guestEmail: string;
  guestCompany?: string;
  guestPhone?: string;
  productsOfInterest?: string[];
  topics?: string[];
  preferredTime?: string;
  notes?: string;
  sourceUrl?: string;
  clientIp?: string;
  userAgent?: string;
  meta?: Record<string, unknown>;
  /** Operator-tz wall-clock date the visitor picked (YYYY-MM-DD). */
  slotDate?: string;
  /** Operator-tz wall-clock time the visitor picked (HH:MM). */
  slotTime?: string;
}

export async function createRequest(
  page: BookingPage,
  input: CreateRequestInput,
): Promise<BookingRequest> {
  const db = getDb();
  // Guard against form-supplied options that aren't on the page's list. We
  // store them anyway (so we don't drop data) but flag in metadata.
  const allowedProducts = new Set(page.products ?? []);
  const allowedTopics = new Set(page.topics ?? []);
  const products = (input.productsOfInterest ?? []).slice(0, 24);
  const topics = (input.topics ?? []).slice(0, 24);
  const offMenuProducts = products.filter((p) => !allowedProducts.has(p));
  const offMenuTopics = topics.filter((t) => !allowedTopics.has(t));

  const meta: Record<string, unknown> = { ...(input.meta ?? {}) };
  if (offMenuProducts.length > 0) meta.off_menu_products = offMenuProducts;
  if (offMenuTopics.length > 0) meta.off_menu_topics = offMenuTopics;

  // If the visitor used the calendar picker, resolve the wall-clock slot
  // into a stable slot key + UTC instant. We also re-check availability to
  // catch the race where two browsers grab the same slot at the same time.
  let slotKey: string | null = null;
  let scheduledAt: Date | null = null;
  if (input.slotDate && input.slotTime) {
    slotKey = buildSlotKey(input.slotDate, input.slotTime);
    const startUtc = localToUtc(input.slotDate, input.slotTime, page.timezone);
    if (!startUtc) {
      throw new ValidationError('Invalid slot', [
        { field: 'slot', reason: 'date or time could not be parsed' },
      ]);
    }
    scheduledAt = startUtc;

    const conflict = await db
      .select({ id: bookingRequests.id })
      .from(bookingRequests)
      .where(
        and(
          eq(bookingRequests.bookingPageId, page.id),
          eq(bookingRequests.slotKey, slotKey),
          inArray(bookingRequests.status, ['pending', 'confirmed']),
        ),
      )
      .limit(1);
    if (conflict.length > 0) {
      throw new ConflictError('That slot was just taken — pick another.', [
        { field: 'slot', reason: 'slot_taken' },
      ]);
    }
  }

  const row: NewBookingRequest = {
    bookingPageId: page.id,
    workspaceId: page.workspaceId,
    guestName: input.guestName.trim(),
    guestEmail: input.guestEmail.trim().toLowerCase(),
    guestCompany: input.guestCompany?.trim() || null,
    guestPhone: input.guestPhone?.trim() || null,
    productsOfInterest: products,
    topics,
    preferredTime: input.preferredTime?.trim() || null,
    notes: input.notes?.trim() || null,
    status: 'pending',
    sourceUrl: input.sourceUrl ?? null,
    clientIp: input.clientIp ?? null,
    userAgent: input.userAgent ?? null,
    meta: meta as Record<string, unknown>,
    scheduledAt,
    slotKey,
  };
  try {
    const [created] = await db.insert(bookingRequests).values(row).returning();
    if (!created) throw new Error('Booking request insert returned no row');
    return created;
  } catch (err) {
    // Belt-and-suspenders: if we add a future unique constraint on (page,
    // slot_key) at the DB layer, surface a friendly conflict.
    if ((err as { code?: string }).code === '23505') {
      throw new ConflictError('That slot was just taken — pick another.', [
        { field: 'slot', reason: 'slot_taken' },
      ]);
    }
    throw err;
  }
}

export interface ListRequestsOpts {
  status?: BookingRequestStatus;
  limit?: number;
}

export async function listRequests(
  workspaceId: string,
  opts: ListRequestsOpts = {},
): Promise<BookingRequest[]> {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const conds = [eq(bookingRequests.workspaceId, workspaceId)];
  if (opts.status) conds.push(eq(bookingRequests.status, opts.status));
  return db
    .select()
    .from(bookingRequests)
    .where(and(...conds))
    .orderBy(desc(bookingRequests.createdAt))
    .limit(limit);
}

/**
 * All booking requests this guest email has ever made into this workspace.
 * Used by the LeadDetail center column to show the operator any pending /
 * confirmed meetings tied to the lead — single lookup, ordered newest first.
 */
export async function listRequestsByGuestEmail(
  workspaceId: string,
  guestEmail: string,
): Promise<BookingRequest[]> {
  const db = getDb();
  return db
    .select()
    .from(bookingRequests)
    .where(
      and(
        eq(bookingRequests.workspaceId, workspaceId),
        eq(bookingRequests.guestEmail, guestEmail.trim().toLowerCase()),
      ),
    )
    .orderBy(desc(bookingRequests.createdAt))
    .limit(50);
}

export async function setRequestStatus(
  workspaceId: string,
  requestId: string,
  status: BookingRequestStatus,
): Promise<BookingRequest> {
  const db = getDb();
  const [updated] = await db
    .update(bookingRequests)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(bookingRequests.workspaceId, workspaceId),
        eq(bookingRequests.id, requestId),
      ),
    )
    .returning();
  if (!updated) throw new NotFoundError('Booking request not found');
  return updated;
}

export async function pendingCount(workspaceId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bookingRequests)
    .where(
      and(
        eq(bookingRequests.workspaceId, workspaceId),
        eq(bookingRequests.status, 'pending'),
      ),
    );
  return rows[0]?.n ?? 0;
}

// Exported defaults for the frontend Settings page's "reset to defaults" affordance.
export const BOOKING_DEFAULTS = {
  products: DEFAULT_PRODUCTS,
  topics: DEFAULT_TOPICS,
};

// Touch a suppress-unused for `asc` import path symmetry — keeps the import set future-friendly.
void asc;
