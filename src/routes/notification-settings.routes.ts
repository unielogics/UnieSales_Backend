import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as notificationService from '../services/notification.service';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');

const SettingsPatch = z.object({
  perKind: z.record(z.string(), z.boolean()).optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietHoursStart: HHMM.optional(),
  quietHoursEnd: HHMM.optional(),
});

const SubscriptionBody = z
  .object({
    deviceToken: z.string().min(1).optional(),
    endpoint: z.string().url().optional(),
    p256dhKey: z.string().optional(),
    authKey: z.string().optional(),
    deviceLabel: z.string().max(120).optional(),
    platform: z.enum(['android-fcm', 'web-push']),
  })
  .refine((b) => !!b.deviceToken || !!b.endpoint, {
    message: 'Either deviceToken (FCM) or endpoint (web-push) is required',
  });

const SubIdPath = z.object({ id: z.string().uuid() });

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, label: string): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ValidationError(
      label,
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

export async function registerNotificationSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users/me/notification-settings', { preHandler: [requireAuth] }, async (req) => {
    const settings = await notificationService.getSettings(req.user!.id);
    return ok(settings);
  });

  app.patch('/api/users/me/notification-settings', { preHandler: [requireAuth] }, async (req) => {
    const patch = parse(SettingsPatch, req.body, 'Validation failed');
    const settings = await notificationService.updateSettings(req.user!.id, patch);
    return ok({
      perKind: settings.perKind,
      quietHoursEnabled: settings.quietHoursEnabled,
      quietHoursStart: settings.quietHoursStart,
      quietHoursEnd: settings.quietHoursEnd,
    });
  });

  app.post('/api/users/me/push-subscriptions', { preHandler: [requireAuth] }, async (req, reply) => {
    const body = parse(SubscriptionBody, req.body, 'Validation failed');
    const subscription = await notificationService.registerSubscription(req.user!.id, body);
    reply.code(201);
    return ok({ subscription }, 'Subscription registered');
  });

  app.delete('/api/users/me/push-subscriptions/:id', { preHandler: [requireAuth] }, async (req) => {
    const { id } = parse(SubIdPath, req.params, 'Invalid path');
    await notificationService.removeSubscription(req.user!.id, id);
    return ok({ ok: true });
  });
}
