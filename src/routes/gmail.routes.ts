import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok, fail } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as gmailService from '../services/gmail.service';
import { env } from '../config/env';

const PathSchema = z.object({ workspaceId: z.string().uuid() });
const AccountPath = PathSchema.extend({ gmailAccountId: z.string().uuid() });

const CallbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
});

const SendSchema = z.object({
  gmailAccountId: z.string().uuid(),
  to: z.string().email(),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(200_000),
  threadId: z.string().optional(),
  inReplyToMessageId: z.string().optional(),
  references: z.string().optional(),
  campaignId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
});

const SyncSchema = z.object({ gmailThreadId: z.string().min(1) });
const SendLimitsSchema = z.object({
  dailySendLimit: z.number().int().min(0).max(1000).optional(),
  maxNewThreadsPerDay: z.number().int().min(0).max(1000).optional(),
});

function parseBody<T extends z.ZodTypeAny>(s: T, body: unknown): z.infer<T> {
  const r = s.safeParse(body);
  if (!r.success) {
    throw new ValidationError(
      'Validation failed',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}
function parsePath<T extends z.ZodTypeAny>(s: T, p: unknown): z.infer<T> {
  const r = s.safeParse(p);
  if (!r.success) {
    throw new ValidationError(
      'Invalid path',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

const READ = [requireAuth, requireWorkspaceMembership];
const WRITE = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

export async function registerGmailRoutes(app: FastifyInstance): Promise<void> {
  // ---- OAuth init ----
  app.post('/api/workspaces/:workspaceId/gmail/connect', { preHandler: WRITE }, async (req) => {
    parsePath(PathSchema, req.params);
    if (!req.user) throw new ValidationError('Not authenticated');
    if (!env().GOOGLE_CLIENT_ID || !env().GOOGLE_CLIENT_SECRET || !env().GOOGLE_REDIRECT_URI) {
      throw new ValidationError(
        'Google OAuth not configured',
        [
          { field: 'GOOGLE_CLIENT_ID', reason: 'missing in Secrets Manager' },
          { field: 'GOOGLE_CLIENT_SECRET', reason: 'missing in Secrets Manager' },
          { field: 'GOOGLE_REDIRECT_URI', reason: 'missing in Secrets Manager' },
        ],
      );
    }
    const url = gmailService.buildAuthUrl(req.workspace!.id, req.user.id);
    return ok({ authUrl: url }, 'Open this URL in a browser to authorise Gmail');
  });

  // ---- OAuth callback ----
  // GOOGLE_REDIRECT_URI must point here (https://api.<domain>/api/auth/google/callback)
  app.get('/api/auth/google/callback', async (req, reply) => {
    const q = CallbackQuery.parse(req.query);
    if (q.error) {
      reply.code(400);
      return fail(`Google returned error: ${q.error}`);
    }
    if (!q.code || !q.state) {
      reply.code(400);
      return fail('Missing code or state in callback');
    }
    const account = await gmailService.handleOAuthCallback(q.code, q.state);
    return ok(
      { gmailAccount: { id: account.id, email: account.email, workspaceId: account.workspaceId } },
      'Gmail account connected',
    );
  });

  // ---- list / detail / sync / pause / send-limits ----
  app.get('/api/workspaces/:workspaceId/gmail/accounts', { preHandler: READ }, async (req) => {
    const accounts = await gmailService.listAccounts(req.workspace!.id);
    // Strip tokens from the API response
    return ok({
      accounts: accounts.map(({ accessTokenEncrypted: _a, refreshTokenEncrypted: _b, ...rest }) => rest),
    });
  });

  app.post(
    '/api/workspaces/:workspaceId/gmail/accounts/:gmailAccountId/sync',
    { preHandler: WRITE },
    async (req) => {
      const { gmailAccountId } = parsePath(AccountPath, req.params);
      const body = parseBody(SyncSchema, req.body ?? {});
      return ok(
        await gmailService.syncThread(req.workspace!.id, gmailAccountId, body.gmailThreadId),
        'Thread synced',
      );
    },
  );

  app.post(
    '/api/workspaces/:workspaceId/gmail/accounts/:gmailAccountId/pause',
    { preHandler: WRITE },
    async (req) => {
      const { gmailAccountId } = parsePath(AccountPath, req.params);
      const account = await gmailService.pauseAccount(req.workspace!.id, gmailAccountId);
      return ok(
        {
          account: {
            id: account.id,
            email: account.email,
            isActive: account.isActive,
            healthStatus: account.healthStatus,
          },
        },
        'Gmail account paused',
      );
    },
  );

  app.delete(
    '/api/workspaces/:workspaceId/gmail/accounts/:gmailAccountId',
    { preHandler: WRITE },
    async (req) => {
      const { gmailAccountId } = parsePath(AccountPath, req.params);
      const account = await gmailService.disconnect(req.workspace!.id, gmailAccountId);
      return ok(
        {
          account: {
            id: account.id,
            email: account.email,
            isActive: account.isActive,
            healthStatus: account.healthStatus,
          },
        },
        'Gmail account disconnected — tokens cleared, history preserved',
      );
    },
  );

  app.patch(
    '/api/workspaces/:workspaceId/gmail/accounts/:gmailAccountId/send-limits',
    { preHandler: WRITE },
    async (req) => {
      const { gmailAccountId } = parsePath(AccountPath, req.params);
      const patch = parseBody(SendLimitsSchema, req.body);
      const account = await gmailService.updateSendLimits(req.workspace!.id, gmailAccountId, patch);
      return ok({
        account: {
          id: account.id,
          email: account.email,
          dailySendLimit: account.dailySendLimit,
          maxNewThreadsPerDay: account.maxNewThreadsPerDay,
        },
      });
    },
  );

  // ---- send / draft (workspace-scoped) ----
  app.post('/api/workspaces/:workspaceId/gmail/send', { preHandler: WRITE }, async (req) => {
    const input = parseBody(SendSchema, req.body);
    return ok(await gmailService.sendEmail({ workspaceId: req.workspace!.id, ...input }), 'Sent');
  });

  app.post('/api/workspaces/:workspaceId/gmail/create-draft', { preHandler: WRITE }, async (req) => {
    const input = parseBody(SendSchema, req.body);
    return ok(await gmailService.createDraft({ workspaceId: req.workspace!.id, ...input }), 'Draft created');
  });

  // ---- check-all-inboxes / process-reply: internal triggers used by gmail-worker (Phase 11) ----
  app.post('/api/gmail/check-all-inboxes', { preHandler: requireAuth }, async () => {
    return ok({ ran: false }, 'Polling worker scheduled in Phase 11; call worker directly for now');
  });
  app.post('/api/gmail/process-reply', { preHandler: requireAuth }, async () => {
    return ok({ processed: false }, 'Reply pipeline implemented end-to-end in Phase 11/12');
  });
}
