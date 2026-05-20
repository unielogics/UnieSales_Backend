import { and, eq } from 'drizzle-orm';
import { google, type Auth } from 'googleapis';
import jwt from 'jsonwebtoken';
import { getDb } from '../config/db';
import { env } from '../config/env';
import { GOOGLE_OAUTH_SCOPES, newOAuthClient, clientWithTokens } from '../config/google';
import { gmailAccounts, type GmailAccount, type NewGmailAccount } from '../db/schema/gmail-accounts';
import { emailThreads, type EmailThread } from '../db/schema/email-threads';
import { emailMessages, type NewEmailMessage } from '../db/schema/email-messages';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { encrypt, decrypt } from './crypto.service';

const STATE_TTL_SECONDS = 600;

interface OAuthState {
  workspaceId: string;
  initiatedBy: string;
  nonce: string;
}

// ---- OAuth flow ----

export function buildAuthUrl(workspaceId: string, initiatedBy: string): string {
  const client = newOAuthClient();
  const payload: OAuthState = {
    workspaceId,
    initiatedBy,
    nonce: Math.random().toString(36).slice(2),
  };
  const state = jwt.sign(payload, env().JWT_SECRET, { expiresIn: STATE_TTL_SECONDS });
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // forces refresh_token issuance
    scope: GOOGLE_OAUTH_SCOPES as unknown as string[],
    state,
  });
}

export function verifyState(stateToken: string): OAuthState {
  try {
    const decoded = jwt.verify(stateToken, env().JWT_SECRET) as OAuthState & jwt.JwtPayload;
    if (!decoded.workspaceId || !decoded.initiatedBy) throw new Error('malformed state');
    return { workspaceId: decoded.workspaceId, initiatedBy: decoded.initiatedBy, nonce: decoded.nonce };
  } catch {
    throw new ValidationError('Invalid or expired OAuth state', [{ field: 'state', reason: 'state failed verification' }]);
  }
}

export async function handleOAuthCallback(code: string, state: string): Promise<GmailAccount> {
  const parsedState = verifyState(state);
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) throw new ValidationError('No access_token from Google');

  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const info = await oauth2.userinfo.get();
  const email = info.data.email;
  if (!email) throw new ValidationError('Google did not return an email for this account');

  const db = getDb();
  const domain = email.split('@')[1] ?? null;
  const expiry = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

  // Upsert by (workspace_id, email)
  const existing = await db
    .select()
    .from(gmailAccounts)
    .where(and(eq(gmailAccounts.workspaceId, parsedState.workspaceId), eq(gmailAccounts.email, email)))
    .limit(1);

  if (existing[0]) {
    const updated = await db
      .update(gmailAccounts)
      .set({
        accessTokenEncrypted: encrypt(tokens.access_token),
        refreshTokenEncrypted: tokens.refresh_token ? encrypt(tokens.refresh_token) : existing[0].refreshTokenEncrypted,
        tokenExpiry: expiry,
        googleUserId: info.data.id ?? existing[0].googleUserId,
        domain: domain ?? existing[0].domain,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(gmailAccounts.id, existing[0].id))
      .returning();
    return updated[0]!;
  }

  if (!tokens.refresh_token) {
    throw new ConflictError('Google did not return a refresh_token. Revoke app access and retry.', [
      { field: 'oauth', reason: 'missing refresh_token; ensure prompt=consent and offline access' },
    ]);
  }

  const inserted = await db
    .insert(gmailAccounts)
    .values({
      workspaceId: parsedState.workspaceId,
      email,
      senderName: info.data.name ?? null,
      googleUserId: info.data.id ?? null,
      accessTokenEncrypted: encrypt(tokens.access_token),
      refreshTokenEncrypted: encrypt(tokens.refresh_token),
      tokenExpiry: expiry,
      domain,
      dailySendLimit: env().DEFAULT_SEND_LIMIT_PER_INBOX,
      maxNewThreadsPerDay: env().DEFAULT_SEND_LIMIT_PER_INBOX,
    } as NewGmailAccount)
    .returning();
  return inserted[0]!;
}

// ---- Account access helpers ----

export async function listAccounts(workspaceId: string): Promise<GmailAccount[]> {
  const db = getDb();
  return db.select().from(gmailAccounts).where(eq(gmailAccounts.workspaceId, workspaceId));
}

export async function getAccount(workspaceId: string, gmailAccountId: string): Promise<GmailAccount> {
  const db = getDb();
  const rows = await db
    .select()
    .from(gmailAccounts)
    .where(and(eq(gmailAccounts.workspaceId, workspaceId), eq(gmailAccounts.id, gmailAccountId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError('Gmail account not found');
  return rows[0];
}

/**
 * Build an authenticated OAuth2 client for the given account, refreshing the
 * access token if it's already expired (or within 60s of expiring).
 */
export async function authClientForAccount(account: GmailAccount): Promise<Auth.OAuth2Client> {
  if (!account.accessTokenEncrypted) throw new ConflictError('Gmail account not connected');
  const accessToken = decrypt(account.accessTokenEncrypted);
  const refreshToken = account.refreshTokenEncrypted ? decrypt(account.refreshTokenEncrypted) : null;
  const client = clientWithTokens({
    accessToken,
    refreshToken,
    expiryDate: account.tokenExpiry,
  });
  // Eagerly refresh if expiry is past or within 60s
  const now = Date.now();
  if (!account.tokenExpiry || account.tokenExpiry.getTime() - now < 60_000) {
    if (!refreshToken) throw new ConflictError('No refresh token; re-connect the Gmail account');
    const res = await client.refreshAccessToken();
    const newAccess = res.credentials.access_token;
    const newExpiry = res.credentials.expiry_date ? new Date(res.credentials.expiry_date) : null;
    if (newAccess) {
      const db = getDb();
      await db
        .update(gmailAccounts)
        .set({
          accessTokenEncrypted: encrypt(newAccess),
          tokenExpiry: newExpiry,
          updatedAt: new Date(),
        })
        .where(eq(gmailAccounts.id, account.id));
      client.setCredentials({
        access_token: newAccess,
        refresh_token: refreshToken,
        expiry_date: newExpiry?.getTime(),
      });
    }
  }
  return client;
}

// ---- Send / draft ----

function buildRawMimeMessage(input: {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyToMessageId?: string;
  references?: string;
}): string {
  const headers: string[] = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
  ];
  if (input.inReplyToMessageId) headers.push(`In-Reply-To: ${input.inReplyToMessageId}`);
  if (input.references) headers.push(`References: ${input.references}`);
  const raw = headers.join('\r\n') + '\r\n\r\n' + input.body;
  return Buffer.from(raw, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface SendInput {
  workspaceId: string;
  gmailAccountId: string;
  to: string;
  subject: string;
  body: string;
  threadId?: string; // Gmail's threadId (string)
  inReplyToMessageId?: string;
  references?: string;
  campaignId?: string;
  leadId?: string;
}

export interface SendResult {
  gmailMessageId: string;
  gmailThreadId: string;
}

export async function sendEmail(input: SendInput): Promise<SendResult> {
  const account = await getAccount(input.workspaceId, input.gmailAccountId);
  if (!account.isActive) throw new ConflictError('Gmail account is not active');
  if (account.healthStatus === 'paused' || account.healthStatus === 'at_risk') {
    throw new ConflictError(`Gmail account health is ${account.healthStatus}`);
  }
  if (account.dailySentCount >= account.dailySendLimit) {
    throw new ConflictError('Daily send limit reached for this Gmail account');
  }

  const client = await authClientForAccount(account);
  const gmail = google.gmail({ version: 'v1', auth: client });

  const raw = buildRawMimeMessage({
    from: account.senderName ? `${account.senderName} <${account.email}>` : account.email,
    to: input.to,
    subject: input.subject,
    body: input.body,
    inReplyToMessageId: input.inReplyToMessageId,
    references: input.references,
  });

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      threadId: input.threadId,
    },
  });
  if (!res.data.id || !res.data.threadId) throw new Error('Gmail send returned no id/threadId');

  // Persist message + thread rows
  const db = getDb();
  let threadRow: EmailThread | undefined;
  const existingThread = await db
    .select()
    .from(emailThreads)
    .where(
      and(
        eq(emailThreads.workspaceId, input.workspaceId),
        eq(emailThreads.gmailThreadId, res.data.threadId),
      ),
    )
    .limit(1);
  if (existingThread[0]) {
    const updated = await db
      .update(emailThreads)
      .set({
        lastOutboundAt: new Date(),
        latestGmailMessageId: res.data.id,
        updatedAt: new Date(),
      })
      .where(eq(emailThreads.id, existingThread[0].id))
      .returning();
    threadRow = updated[0]!;
  } else {
    const inserted = await db
      .insert(emailThreads)
      .values({
        workspaceId: input.workspaceId,
        campaignId: input.campaignId ?? null,
        leadId: input.leadId ?? null,
        gmailAccountId: input.gmailAccountId,
        gmailThreadId: res.data.threadId,
        latestGmailMessageId: res.data.id,
        subject: input.subject,
        lastOutboundAt: new Date(),
      })
      .returning();
    threadRow = inserted[0]!;
  }

  await db.insert(emailMessages).values({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId ?? null,
    leadId: input.leadId ?? null,
    emailThreadId: threadRow!.id,
    gmailMessageId: res.data.id,
    gmailThreadId: res.data.threadId,
    direction: 'outbound',
    fromEmail: account.email,
    toEmail: input.to,
    subject: input.subject,
    body: input.body,
  } as NewEmailMessage);

  await db
    .update(gmailAccounts)
    .set({
      dailySentCount: account.dailySentCount + 1,
      lastSyncAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(gmailAccounts.id, account.id));

  return { gmailMessageId: res.data.id, gmailThreadId: res.data.threadId };
}

export async function createDraft(input: SendInput): Promise<{ draftId: string; gmailThreadId?: string }> {
  const account = await getAccount(input.workspaceId, input.gmailAccountId);
  const client = await authClientForAccount(account);
  const gmail = google.gmail({ version: 'v1', auth: client });
  const raw = buildRawMimeMessage({
    from: account.senderName ? `${account.senderName} <${account.email}>` : account.email,
    to: input.to,
    subject: input.subject,
    body: input.body,
    inReplyToMessageId: input.inReplyToMessageId,
    references: input.references,
  });
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw, threadId: input.threadId } },
  });
  if (!res.data.id) throw new Error('Gmail draft returned no id');

  // Persist a draft message row so the UI can show it in the AI queue.
  const db = getDb();
  await db.insert(emailMessages).values({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId ?? null,
    leadId: input.leadId ?? null,
    gmailMessageId: res.data.id,
    gmailThreadId: input.threadId ?? null,
    direction: 'draft',
    fromEmail: account.email,
    toEmail: input.to,
    subject: input.subject,
    body: input.body,
  } as NewEmailMessage);

  return { draftId: res.data.id, gmailThreadId: res.data.message?.threadId ?? input.threadId };
}

// ---- Thread fetch / sync ----

export async function syncThread(
  workspaceId: string,
  gmailAccountId: string,
  gmailThreadId: string,
): Promise<{ messagesSynced: number }> {
  const account = await getAccount(workspaceId, gmailAccountId);
  const client = await authClientForAccount(account);
  const gmail = google.gmail({ version: 'v1', auth: client });

  const thread = await gmail.users.threads.get({ userId: 'me', id: gmailThreadId, format: 'full' });
  const messages = thread.data.messages ?? [];

  const db = getDb();
  // Upsert thread row
  let threadRow: EmailThread;
  const existingThread = await db
    .select()
    .from(emailThreads)
    .where(and(eq(emailThreads.workspaceId, workspaceId), eq(emailThreads.gmailThreadId, gmailThreadId)))
    .limit(1);
  if (existingThread[0]) {
    threadRow = existingThread[0];
  } else {
    const subjHeader = messages[0]?.payload?.headers?.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? null;
    const inserted = await db
      .insert(emailThreads)
      .values({
        workspaceId,
        gmailAccountId,
        gmailThreadId,
        subject: subjHeader,
      })
      .returning();
    threadRow = inserted[0]!;
  }

  let synced = 0;
  for (const m of messages) {
    if (!m.id) continue;
    const existing = await db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(and(eq(emailMessages.workspaceId, workspaceId), eq(emailMessages.gmailMessageId, m.id)))
      .limit(1);
    if (existing[0]) continue;
    const headers = m.payload?.headers ?? [];
    const findHeader = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
    const from = findHeader('From');
    const to = findHeader('To');
    const subject = findHeader('Subject');
    const direction = from?.toLowerCase().includes(account.email.toLowerCase()) ? 'outbound' : 'inbound';
    const body = extractPlainTextBody(m);

    await db.insert(emailMessages).values({
      workspaceId,
      emailThreadId: threadRow.id,
      gmailMessageId: m.id,
      gmailThreadId,
      direction,
      fromEmail: from,
      toEmail: to,
      subject,
      body,
    } as NewEmailMessage);
    synced++;
  }

  await db
    .update(emailThreads)
    .set({ updatedAt: new Date(), latestGmailMessageId: messages[messages.length - 1]?.id ?? threadRow.latestGmailMessageId })
    .where(eq(emailThreads.id, threadRow.id));

  return { messagesSynced: synced };
}

function extractPlainTextBody(message: {
  payload?: { mimeType?: string | null; body?: { data?: string | null } | null; parts?: unknown };
}): string {
  // Walk payload tree looking for text/plain
  const decode = (s?: string | null): string => (s ? Buffer.from(s, 'base64').toString('utf-8') : '');
  const walk = (node: {
    mimeType?: string | null;
    body?: { data?: string | null } | null;
    parts?: unknown;
  }): string | null => {
    if (!node) return null;
    if (node.mimeType === 'text/plain' && node.body?.data) return decode(node.body.data);
    if (Array.isArray(node.parts)) {
      for (const p of node.parts) {
        const got = walk(p as never);
        if (got) return got;
      }
    }
    return null;
  };
  const text = walk(message.payload as never);
  if (text) return text;
  // Fall back to anything we can find
  if (message.payload?.body?.data) return decode(message.payload.body.data);
  return '';
}

/**
 * Disconnect a Gmail account: clears encrypted tokens, marks inactive.
 * Preserves history (threads + messages stay linked) so analytics and the AI
 * can still reason about past activity.
 */
export async function disconnect(workspaceId: string, gmailAccountId: string): Promise<GmailAccount> {
  await getAccount(workspaceId, gmailAccountId);
  const db = getDb();
  const rows = await db
    .update(gmailAccounts)
    .set({
      isActive: false,
      healthStatus: 'disconnected',
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      tokenExpiry: null,
      updatedAt: new Date(),
    })
    .where(and(eq(gmailAccounts.workspaceId, workspaceId), eq(gmailAccounts.id, gmailAccountId)))
    .returning();
  return rows[0]!;
}

export async function pauseAccount(workspaceId: string, gmailAccountId: string): Promise<GmailAccount> {
  await getAccount(workspaceId, gmailAccountId);
  const db = getDb();
  const rows = await db
    .update(gmailAccounts)
    .set({ isActive: false, healthStatus: 'paused', updatedAt: new Date() })
    .where(and(eq(gmailAccounts.workspaceId, workspaceId), eq(gmailAccounts.id, gmailAccountId)))
    .returning();
  return rows[0]!;
}

export async function updateSendLimits(
  workspaceId: string,
  gmailAccountId: string,
  patch: { dailySendLimit?: number; maxNewThreadsPerDay?: number },
): Promise<GmailAccount> {
  await getAccount(workspaceId, gmailAccountId);
  const db = getDb();
  const rows = await db
    .update(gmailAccounts)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(gmailAccounts.workspaceId, workspaceId), eq(gmailAccounts.id, gmailAccountId)))
    .returning();
  return rows[0]!;
}
