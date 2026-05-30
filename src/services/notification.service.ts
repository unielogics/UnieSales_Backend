/**
 * Notification service — append-only business-event feed + FCM push delivery.
 *
 * `create()` inserts a notification row and then (best-effort, fire-and-forget)
 * pushes it to the recipients' registered devices via FCM. Push delivery is
 * gated by each recipient's settings (per-kind toggle + quiet hours) and is a
 * complete no-op when Firebase isn't configured (FIREBASE_SERVICE_ACCOUNT_JSON
 * empty) — so this ships safely before the mobile push wiring (Phase 3).
 */
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { env } from '../config/env';
import {
  notifications,
  type Notification,
  type NewNotification,
  type NotificationKind,
  type NotificationPriority,
} from '../db/schema/notifications';
import {
  notificationSettings,
  type NotificationSettings,
} from '../db/schema/notification-settings';
import { pushSubscriptions } from '../db/schema/push-subscriptions';
import { workspaceMembers } from '../db/schema/workspace-members';

export interface CreateNotificationInput {
  workspaceId: string;
  userId?: string | null;
  kind: NotificationKind;
  priority?: NotificationPriority;
  title: string;
  body?: string | null;
  meta?: string | null;
  leadId?: string | null;
  threadId?: string | null;
}

export async function create(input: CreateNotificationInput): Promise<Notification> {
  const db = getDb();
  const row: NewNotification = {
    workspaceId: input.workspaceId,
    userId: input.userId ?? null,
    kind: input.kind,
    priority: input.priority ?? 'normal',
    title: input.title,
    body: input.body ?? null,
    meta: input.meta ?? null,
    leadId: input.leadId ?? null,
    threadId: input.threadId ?? null,
  };
  const [inserted] = await db.insert(notifications).values(row).returning();
  if (!inserted) throw new Error('notification create: insert returned no row');

  // Fire-and-forget push. Never let push failure affect the caller.
  void deliverPush(inserted).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('push delivery failed', err);
  });

  return inserted;
}

/**
 * Convenience helper for event hooks: best-effort, swallows all errors so a
 * notification failure can never break the business action that triggered it.
 */
export async function emit(input: CreateNotificationInput): Promise<void> {
  try {
    await create(input);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('notification emit failed', input.kind, err);
  }
}

export interface ListOpts {
  unread?: boolean;
  userId?: string;
  limit?: number;
  offset?: number;
}

export async function list(workspaceId: string, opts: ListOpts = {}): Promise<Notification[]> {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conds = [eq(notifications.workspaceId, workspaceId)];
  if (opts.unread) conds.push(isNull(notifications.readAt));
  // Workspace-wide (user_id null) rows are visible to everyone; targeted rows
  // only to that user.
  if (opts.userId) {
    conds.push(or(isNull(notifications.userId), eq(notifications.userId, opts.userId))!);
  }
  return db
    .select()
    .from(notifications)
    .where(and(...conds))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .offset(opts.offset ?? 0);
}

export async function getCounts(
  workspaceId: string,
  userId?: string,
): Promise<{ total: number; unread: number; urgent: number }> {
  const db = getDb();
  const visibility = userId
    ? or(isNull(notifications.userId), eq(notifications.userId, userId))!
    : undefined;
  const where = visibility
    ? and(eq(notifications.workspaceId, workspaceId), visibility)
    : eq(notifications.workspaceId, workspaceId);
  const [r] = await db
    .select({
      total: sql<number>`count(*)::int`,
      unread: sql<number>`count(*) filter (where ${notifications.readAt} is null)::int`,
      urgent: sql<number>`count(*) filter (where ${notifications.readAt} is null and ${notifications.priority} in ('urgent','high'))::int`,
    })
    .from(notifications)
    .where(where);
  return { total: r?.total ?? 0, unread: r?.unread ?? 0, urgent: r?.urgent ?? 0 };
}

export async function markRead(workspaceId: string, id: string): Promise<Notification> {
  const db = getDb();
  const [updated] = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.id, id)))
    .returning();
  if (!updated) throw new Error('markRead: notification not found');
  return updated;
}

export async function markAllRead(workspaceId: string, userId?: string): Promise<{ updated: number }> {
  const db = getDb();
  const conds = [eq(notifications.workspaceId, workspaceId), isNull(notifications.readAt)];
  if (userId) conds.push(or(isNull(notifications.userId), eq(notifications.userId, userId))!);
  const res = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(...conds))
    .returning({ id: notifications.id });
  return { updated: res.length };
}

// ─── Settings ────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  perKind: {} as Record<string, boolean>,
  quietHoursEnabled: true,
  quietHoursStart: '21:00',
  quietHoursEnd: '07:00',
};

export async function getSettings(userId: string): Promise<{
  perKind: Record<string, boolean>;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.userId, userId))
    .limit(1);
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    perKind: row.perKind ?? {},
    quietHoursEnabled: row.quietHoursEnabled,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
  };
}

export async function updateSettings(
  userId: string,
  patch: Partial<{
    perKind: Record<string, boolean>;
    quietHoursEnabled: boolean;
    quietHoursStart: string;
    quietHoursEnd: string;
  }>,
): Promise<NotificationSettings> {
  const db = getDb();
  const current = await getSettings(userId);
  const merged = {
    userId,
    perKind: patch.perKind ?? current.perKind,
    quietHoursEnabled: patch.quietHoursEnabled ?? current.quietHoursEnabled,
    quietHoursStart: patch.quietHoursStart ?? current.quietHoursStart,
    quietHoursEnd: patch.quietHoursEnd ?? current.quietHoursEnd,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(notificationSettings)
    .values(merged)
    .onConflictDoUpdate({
      target: notificationSettings.userId,
      set: {
        perKind: merged.perKind,
        quietHoursEnabled: merged.quietHoursEnabled,
        quietHoursStart: merged.quietHoursStart,
        quietHoursEnd: merged.quietHoursEnd,
        updatedAt: merged.updatedAt,
      },
    })
    .returning();
  if (!row) throw new Error('updateSettings: upsert returned no row');
  return row;
}

// ─── Push subscriptions ──────────────────────────────────────────────────────
export interface RegisterSubInput {
  deviceToken?: string;
  endpoint?: string;
  p256dhKey?: string;
  authKey?: string;
  deviceLabel?: string;
  platform: 'android-fcm' | 'web-push';
}

export async function registerSubscription(userId: string, sub: RegisterSubInput) {
  const db = getDb();
  // Dedup on (user, deviceToken). If the token already exists, refresh
  // last_used_at; otherwise insert.
  const [row] = await db
    .insert(pushSubscriptions)
    .values({
      userId,
      deviceToken: sub.deviceToken ?? null,
      endpoint: sub.endpoint ?? null,
      p256dhKey: sub.p256dhKey ?? null,
      authKey: sub.authKey ?? null,
      deviceLabel: sub.deviceLabel ?? null,
      platform: sub.platform,
      lastUsedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [pushSubscriptions.userId, pushSubscriptions.deviceToken],
      set: { lastUsedAt: new Date(), deviceLabel: sub.deviceLabel ?? null, platform: sub.platform },
    })
    .returning();
  return row;
}

export async function removeSubscription(userId: string, id: string): Promise<void> {
  const db = getDb();
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.id, id)));
}

// ─── FCM push delivery (best-effort, no-op without Firebase) ──────────────────
// Must match the channel the mobile app creates in src/lib/push.ts. Routing to
// a high-importance channel is what makes alerts pop (heads-up + sound + badge).
const PUSH_CHANNEL_ID = 'uniesales_alerts';

async function deliverPush(n: Notification): Promise<void> {
  const serviceAccountJson = env().FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) return; // Firebase not configured — persist-only.

  const db = getDb();

  // Resolve recipient user ids: a targeted notification goes to its user;
  // a workspace-wide one goes to every member.
  let recipientIds: string[];
  if (n.userId) {
    recipientIds = [n.userId];
  } else {
    const members = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, n.workspaceId));
    recipientIds = members.map((m) => m.userId);
  }
  if (recipientIds.length === 0) return;

  // Apply per-recipient settings (per-kind toggle + quiet hours).
  const allowed: string[] = [];
  for (const uid of recipientIds) {
    const s = await getSettings(uid);
    if (s.perKind[n.kind] === false) continue;
    if (s.quietHoursEnabled && n.priority !== 'urgent' && inQuietHours(s.quietHoursStart, s.quietHoursEnd)) {
      continue;
    }
    allowed.push(uid);
  }
  if (allowed.length === 0) return;

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(
      and(inArray(pushSubscriptions.userId, allowed), eq(pushSubscriptions.platform, 'android-fcm')),
    );
  const tokens = subs.map((s) => s.deviceToken).filter((t): t is string => !!t);
  if (tokens.length === 0) return;

  const messaging = await getMessaging(serviceAccountJson);
  if (!messaging) return;

  // Data payload carries the deep-link target so the app opens the right sheet.
  const data: Record<string, string> = { kind: n.kind, priority: n.priority };
  if (n.leadId) data.leadId = n.leadId;
  if (n.threadId) data.threadId = n.threadId;

  // High-importance channel + sound so it surfaces on the lock screen / heads-up.
  // The app-icon badge count is only meaningful for a single recipient, so we
  // set it for targeted notifications (workspace-wide ones span many users).
  const androidNotification: Record<string, unknown> = {
    channelId: PUSH_CHANNEL_ID,
    sound: 'default',
  };
  if (n.userId) {
    const { unread } = await getCounts(n.workspaceId, n.userId);
    androidNotification.notificationCount = unread;
  }

  await messaging.sendEachForMulticast({
    tokens,
    notification: { title: n.title, body: n.body ?? '' },
    data,
    android: {
      priority: n.priority === 'urgent' || n.priority === 'high' ? 'high' : 'normal',
      notification: androidNotification,
    },
  });
}

// Lazily init the Firebase Admin SDK from the service-account JSON. Uses a
// non-literal import specifier so the build doesn't require firebase-admin to
// be installed until Phase 3.
let cachedMessaging: { sendEachForMulticast: (msg: unknown) => Promise<unknown> } | null = null;
async function getMessaging(serviceAccountJson: string) {
  if (cachedMessaging) return cachedMessaging;
  try {
    const moduleName = 'firebase-admin';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin: any = await import(moduleName);
    const app = admin.apps?.length
      ? admin.app()
      : admin.initializeApp({ credential: admin.credential.cert(JSON.parse(serviceAccountJson)) });
    cachedMessaging = admin.messaging(app);
    return cachedMessaging;
  } catch (err) {
    // firebase-admin not installed yet (pre-Phase 3) — silently skip.
    // eslint-disable-next-line no-console
    console.warn('firebase-admin unavailable; skipping push', err instanceof Error ? err.message : err);
    return null;
  }
}

/** True if the current local time falls within [start,end] quiet window (handles overnight wrap). */
function inQuietHours(start: string, end: string): boolean {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  return (h || 0) * 60 + (m || 0);
}
