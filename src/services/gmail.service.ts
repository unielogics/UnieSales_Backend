import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { google, type Auth } from 'googleapis';
import jwt from 'jsonwebtoken';
import { getDb } from '../config/db';
import { env } from '../config/env';
import { GOOGLE_OAUTH_SCOPES, newOAuthClient, clientWithTokens } from '../config/google';
import { gmailAccounts, type GmailAccount, type NewGmailAccount } from '../db/schema/gmail-accounts';
import { workspaces } from '../db/schema/workspaces';
import { leads } from '../db/schema/leads';
import { emailThreads, type EmailThread } from '../db/schema/email-threads';
import { emailMessages, type NewEmailMessage } from '../db/schema/email-messages';
import { campaignKnowledgeFiles } from '../db/schema/campaign-knowledge-files';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { encrypt, decrypt } from './crypto.service';
import { getObjectBuffer } from './s3.service';

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
        connectedByUserId: existing[0].connectedByUserId ?? parsedState.initiatedBy,
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
      connectedByUserId: parsedState.initiatedBy,
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

// RFC 2047 encoded-word — required for non-ASCII characters in mail headers
// (an em-dash in a raw header is what produced the `Ã¢Â€Â"` mojibake).
function encodeHeaderWord(s: string): string {
  if (/^[\x20-\x7E]*$/.test(s)) return s; // pure printable ASCII — leave as-is
  return `=?UTF-8?B?${Buffer.from(s, 'utf-8').toString('base64')}?=`;
}

// Encode the display-name portion of a "Name <email>" address header.
function encodeAddressHeader(value: string): string {
  const m = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!m) return value;
  const name = (m[1] ?? '').trim();
  const email = (m[2] ?? '').trim();
  return name ? `${encodeHeaderWord(name)} <${email}>` : `<${email}>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Plain-text AI body → simple HTML (escape, newlines → <br>).
function plainToHtml(body: string): string {
  return escapeHtml(body).replace(/\r?\n/g, '<br>\n');
}

// Strip an HTML footer down to a plain-text approximation for the text/plain part.
function htmlToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// base64 content for a MIME part, wrapped at 76 chars per RFC 2045.
function b64Part(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64').replace(/(.{76})/g, '$1\r\n');
}

function b64Buffer(buf: Buffer): string {
  return buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
}

/** A file to attach to an outbound email. */
export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

function sanitizeFilename(name: string): string {
  return (name || 'attachment').replace(/["\r\n\\]/g, '').trim() || 'attachment';
}

/**
 * Build an outbound MIME message. The text+html bodies form a
 * multipart/alternative entity; when attachments are present the whole thing
 * is wrapped in multipart/mixed. Everything non-trivial is base64 encoded.
 */
/**
 * Find-or-create the two Gmail labels we use to tag UnieSales traffic inside
 * the operator's mailbox. Idempotent — listing labels is cheap, creating
 * happens at most once per account.
 *
 *   UnieSales/Sent     — every message UnieSales sends through this account
 *   UnieSales/Replies  — every inbound reply on a tracked thread (lead reply)
 *
 * The combined parent-label naming (`UnieSales/...`) makes Gmail nest them
 * under a single collapsible "UnieSales" folder in the sidebar. Operator can
 * one-click "Skip Inbox" via a filter to keep their personal Inbox clean.
 */
async function ensureUnieSalesLabels(
  gmail: ReturnType<typeof google.gmail>,
): Promise<{ sent: string; replies: string }> {
  const list = await gmail.users.labels.list({ userId: 'me' });
  const all = list.data.labels ?? [];
  const find = (name: string) =>
    all.find((l) => (l.name ?? '').toLowerCase() === name.toLowerCase())?.id ?? null;
  let sent = find('UnieSales/Sent');
  let replies = find('UnieSales/Replies');
  if (!sent) {
    const created = await gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name: 'UnieSales/Sent',
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    });
    sent = created.data.id ?? null;
  }
  if (!replies) {
    const created = await gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name: 'UnieSales/Replies',
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    });
    replies = created.data.id ?? null;
  }
  if (!sent || !replies) {
    throw new Error('Failed to resolve UnieSales Gmail labels');
  }
  return { sent, replies };
}

/**
 * Apply a label to a Gmail message. Best-effort — labelling is a UX nicety;
 * if Gmail rejects (rate limit, missing scope, transient), the send/sync still
 * succeeds. Errors get logged at warn level upstream.
 */
async function applyLabel(
  gmail: ReturnType<typeof google.gmail>,
  messageId: string,
  labelId: string,
): Promise<void> {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}

function buildRawMimeMessage(input: {
  from: string;
  to: string;
  subject: string;
  body: string;
  footerHtml?: string | null;
  inReplyToMessageId?: string;
  references?: string;
  attachments?: EmailAttachment[];
  /**
   * Custom RFC 5322 headers — used to stamp every UnieSales outbound message
   * with X-UnieSales-WorkspaceId / -LeadId / -CampaignId / -Origin so the
   * operator's Gmail can identify our traffic via filters even if the
   * UnieSales/Sent label is missing for some reason. Values are inserted
   * verbatim and must be 7-bit ASCII (UUIDs always are).
   */
  customHeaders?: Record<string, string>;
}): string {
  const footerHtml = (input.footerHtml ?? '').trim();
  const footerText = footerHtml ? htmlToPlain(footerHtml) : '';

  const plainBody = footerText ? `${input.body}\n\n${footerText}` : input.body;
  const htmlBody =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222">' +
    plainToHtml(input.body) +
    (footerHtml ? `<br><br>${footerHtml}` : '') +
    '</div>';

  const altBoundary = `alt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  // A self-contained multipart/alternative entity (its own Content-Type + body).
  const altEntity =
    `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n` +
    [
      `--${altBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      b64Part(plainBody),
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      b64Part(htmlBody),
      `--${altBoundary}--`,
    ].join('\r\n');

  const headers: string[] = [
    `From: ${encodeAddressHeader(input.from)}`,
    `To: ${encodeAddressHeader(input.to)}`,
    `Subject: ${encodeHeaderWord(input.subject)}`,
    'MIME-Version: 1.0',
  ];
  if (input.inReplyToMessageId) headers.push(`In-Reply-To: ${input.inReplyToMessageId}`);
  if (input.references) headers.push(`References: ${input.references}`);
  if (input.customHeaders) {
    for (const [k, v] of Object.entries(input.customHeaders)) {
      // Strip CR/LF defensively so an attacker-controlled value can't inject
      // additional headers. Our values are UUIDs + safe enums so this is
      // belt-and-suspenders.
      const safe = String(v).replace(/[\r\n]+/g, ' ');
      headers.push(`${k}: ${safe}`);
    }
  }

  const attachments = (input.attachments ?? []).filter((a) => a.content.length > 0);

  let raw: string;
  if (attachments.length === 0) {
    // No attachments — the message body is the multipart/alternative entity.
    raw = headers.join('\r\n') + '\r\n' + altEntity;
  } else {
    const mixed = `mixed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const parts: string[] = [`--${mixed}`, altEntity];
    for (const a of attachments) {
      const fname = sanitizeFilename(a.filename);
      parts.push(
        `--${mixed}`,
        `Content-Type: ${a.contentType}; name="${fname}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${fname}"`,
        '',
        b64Buffer(a.content),
      );
    }
    parts.push(`--${mixed}--`);
    raw =
      headers.join('\r\n') +
      '\r\n' +
      `Content-Type: multipart/mixed; boundary="${mixed}"\r\n\r\n` +
      parts.join('\r\n');
  }
  return Buffer.from(raw, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // Gmail caps at 25MB; stay under.

function guessContentType(name: string, fileType: string | null): string {
  if (fileType && fileType.includes('/')) return fileType;
  const ext = (name.toLowerCase().split('.').pop() ?? '').trim();
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * Resolve campaign knowledge files (chosen by the AI) into email attachments.
 * Only files explicitly flagged attach_to_emails are eligible — never internal
 * docs. Silently skips missing objects and anything over the size budget.
 */
async function resolveAttachments(workspaceId: string, fileIds: string[]): Promise<EmailAttachment[]> {
  const ids = [...new Set(fileIds)].filter(Boolean);
  if (ids.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(campaignKnowledgeFiles)
    .where(
      and(
        eq(campaignKnowledgeFiles.workspaceId, workspaceId),
        inArray(campaignKnowledgeFiles.id, ids),
        eq(campaignKnowledgeFiles.attachToEmails, true),
        eq(campaignKnowledgeFiles.isActive, true),
      ),
    );

  const out: EmailAttachment[] = [];
  let total = 0;
  for (const r of rows) {
    if (!r.s3Url) continue;
    try {
      const key = r.s3Url.replace(/^s3:\/\/[^/]+\//, '');
      const buf = await getObjectBuffer(key);
      if (total + buf.length > MAX_ATTACHMENT_BYTES) continue;
      total += buf.length;
      out.push({
        filename: r.fileName,
        contentType: guessContentType(r.fileName, r.fileType),
        content: buf,
      });
    } catch {
      // missing / unreadable object — skip it rather than fail the whole send
    }
  }
  return out;
}

/** The workspace's configured HTML footer/signature, or null. */
async function getWorkspaceFooter(workspaceId: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ footer: workspaces.emailFooterHtml })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0]?.footer ?? null;
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
  // Warm-up / playground sends bypass the at-risk health gate — low-volume
  // operator-driven sends are how a domain *rebuilds* reputation. A 'paused'
  // account is still blocked.
  bypassHealthGate?: boolean;
  /** Transactional sends (booking confirmations/reminders) should not consume campaign daily budget. */
  bypassDailyLimit?: boolean;
  /** Campaign knowledge file ids to attach (must be flagged attach_to_emails). */
  attachmentFileIds?: string[];
}

export interface SendResult {
  gmailMessageId: string;
  gmailThreadId: string;
}

export async function sendEmail(input: SendInput): Promise<SendResult> {
  const account = await getAccount(input.workspaceId, input.gmailAccountId);
  if (!account.isActive) throw new ConflictError('Gmail account is not active');
  if (account.healthStatus === 'paused') {
    throw new ConflictError('Gmail account is paused');
  }
  if (account.healthStatus === 'at_risk' && !input.bypassHealthGate) {
    throw new ConflictError('Gmail account health is at_risk');
  }
  if (!input.bypassDailyLimit && account.dailySentCount >= account.dailySendLimit) {
    throw new ConflictError('Daily send limit reached for this Gmail account');
  }

  const client = await authClientForAccount(account);
  const gmail = google.gmail({ version: 'v1', auth: client });

  const footerHtml = await getWorkspaceFooter(input.workspaceId);
  const attachments = await resolveAttachments(input.workspaceId, input.attachmentFileIds ?? []);
  // Stamp every UnieSales-originated message with identifiers Gmail filters
  // can match on. Operator can then route, label, or skip-inbox without
  // depending on the UnieSales/Sent label (which can be deleted manually).
  const customHeaders: Record<string, string> = {
    'X-UnieSales-Origin': 'send',
    'X-UnieSales-WorkspaceId': input.workspaceId,
  };
  if (input.campaignId) customHeaders['X-UnieSales-CampaignId'] = input.campaignId;
  if (input.leadId) customHeaders['X-UnieSales-LeadId'] = input.leadId;
  const raw = buildRawMimeMessage({
    from: account.senderName ? `${account.senderName} <${account.email}>` : account.email,
    to: input.to,
    subject: input.subject,
    body: input.body,
    footerHtml,
    inReplyToMessageId: input.inReplyToMessageId,
    references: input.references,
    attachments,
    customHeaders,
  });

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      threadId: input.threadId,
    },
  });
  if (!res.data.id || !res.data.threadId) throw new Error('Gmail send returned no id/threadId');

  // Tag the just-sent message with UnieSales/Sent so it's visible as a
  // distinct label in the operator's Gmail sidebar. Best-effort: if labelling
  // fails the send itself still succeeded and our DB rows are authoritative.
  try {
    const labels = await ensureUnieSalesLabels(gmail);
    await applyLabel(gmail, res.data.id, labels.sent);
  } catch (err) {
    // Don't break send for a labelling glitch — log and move on.
    // eslint-disable-next-line no-console
    console.warn('[gmail.sendEmail] label apply failed', err);
  }

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
      dailySentCount: input.bypassDailyLimit ? account.dailySentCount : account.dailySentCount + 1,
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
  const footerHtml = await getWorkspaceFooter(input.workspaceId);
  // Same stamping as sendEmail so drafts UnieSales creates are identifiable
  // in the operator's Gmail Drafts folder by header.
  const customHeaders: Record<string, string> = {
    'X-UnieSales-Origin': 'draft',
    'X-UnieSales-WorkspaceId': input.workspaceId,
  };
  if (input.campaignId) customHeaders['X-UnieSales-CampaignId'] = input.campaignId;
  if (input.leadId) customHeaders['X-UnieSales-LeadId'] = input.leadId;
  const raw = buildRawMimeMessage({
    from: account.senderName ? `${account.senderName} <${account.email}>` : account.email,
    to: input.to,
    subject: input.subject,
    body: input.body,
    footerHtml,
    inReplyToMessageId: input.inReplyToMessageId,
    references: input.references,
    customHeaders,
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

/** Pull every email address out of a header value (handles "Name <a@b.com>, c@d.com"). */
function extractEmails(headerValue: string | null | undefined): string[] {
  if (!headerValue) return [];
  return (headerValue.match(/[\w.+-]+@[\w.-]+\.[\w-]+/g) ?? []).map((e) => e.toLowerCase());
}

export interface SyncThreadResult {
  messagesSynced: number;
  // Set when a NEW inbound message arrived on a campaign-linked thread —
  // the gmail worker hands this to the reply processor.
  newInboundReply: { threadId: string; leadId: string; campaignId: string } | null;
}

export async function syncThread(
  workspaceId: string,
  gmailAccountId: string,
  gmailThreadId: string,
): Promise<SyncThreadResult> {
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
    // Only ingest a NEW thread if one of its participants is a known lead.
    // Booking-page / intake leads may not have a campaign_id yet, but the
    // operator still needs their Gmail history centralized in the lead file.
    const participants = new Set<string>();
    for (const m of messages) {
      const hs = m.payload?.headers ?? [];
      for (const name of ['From', 'To', 'Cc']) {
        const v = hs.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;
        for (const e of extractEmails(v)) {
          if (e !== account.email.toLowerCase()) participants.add(e);
        }
      }
    }
    if (participants.size === 0) return { messagesSynced: 0, newInboundReply: null };

    const matchedLead = (
      await db
        .select({ id: leads.id, campaignId: leads.campaignId })
        .from(leads)
        .where(
          and(
            eq(leads.workspaceId, workspaceId),
            inArray(leads.email, [...participants]),
          ),
        )
        .limit(1)
    )[0];
    if (!matchedLead) return { messagesSynced: 0, newInboundReply: null };

    const subjHeader = messages[0]?.payload?.headers?.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? null;
    const inserted = await db
      .insert(emailThreads)
      .values({
        workspaceId,
        campaignId: matchedLead.campaignId,
        leadId: matchedLead.id,
        gmailAccountId,
        gmailThreadId,
        subject: subjHeader,
      })
      .returning();
    threadRow = inserted[0]!;
  }

  let synced = 0;
  let newInbound = false;
  // Collect Gmail message ids we should label after the loop. Done in a
  // single batch at the end so we don't trip Gmail's per-call rate limits
  // when a thread has many new messages at once.
  const inboundIdsToLabel: string[] = [];
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
    if (direction === 'inbound') {
      newInbound = true;
      inboundIdsToLabel.push(m.id);
    }

    await db.insert(emailMessages).values({
      workspaceId,
      campaignId: threadRow.campaignId,
      leadId: threadRow.leadId,
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

  // Tag freshly-ingested inbound messages with UnieSales/Replies so the
  // operator's Gmail surface mirrors what UnieSales sees as a lead reply.
  // Best-effort: a label failure doesn't roll back the DB state above.
  if (inboundIdsToLabel.length > 0) {
    try {
      const labels = await ensureUnieSalesLabels(gmail);
      for (const id of inboundIdsToLabel) {
        try {
          await applyLabel(gmail, id, labels.replies);
        } catch {
          // Single-message label failure: move on; the message is in our DB.
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[gmail.syncThread] reply label apply failed', err);
    }
  }

  await db
    .update(emailThreads)
    .set({
      updatedAt: new Date(),
      latestGmailMessageId: messages[messages.length - 1]?.id ?? threadRow.latestGmailMessageId,
      ...(newInbound ? { lastInboundAt: new Date() } : {}),
    })
    .where(eq(emailThreads.id, threadRow.id));

  // A fresh inbound reply on a campaign thread → the worker should process it.
  const newInboundReply =
    newInbound && threadRow.leadId && threadRow.campaignId
      ? { threadId: threadRow.id, leadId: threadRow.leadId, campaignId: threadRow.campaignId }
      : null;

  return { messagesSynced: synced, newInboundReply };
}

/**
 * Search every connected Gmail account for threads involving an email address
 * and sync the matches into UnieSales. The related-conversations endpoint uses
 * this as a best-effort hydration step before reading from the local DB.
 */
export async function searchAndSyncThreadsByEmail(
  workspaceId: string,
  email: string,
  maxPerAccount = 10,
): Promise<{ searchedAccounts: number; threadsSeen: number; messagesSynced: number }> {
  const needle = email.trim().toLowerCase();
  if (!needle) return { searchedAccounts: 0, threadsSeen: 0, messagesSynced: 0 };

  const accounts = (await listAccounts(workspaceId)).filter(
    (a) => a.isActive && a.healthStatus !== 'paused',
  );
  let threadsSeen = 0;
  let messagesSynced = 0;

  for (const account of accounts) {
    try {
      const client = await authClientForAccount(account);
      const gmail = google.gmail({ version: 'v1', auth: client });
      const res = await gmail.users.threads.list({
        userId: 'me',
        q: `{from:${needle} to:${needle} cc:${needle}}`,
        maxResults: maxPerAccount,
      });
      const threads = res.data.threads ?? [];
      threadsSeen += threads.length;
      for (const t of threads) {
        if (!t.id) continue;
        try {
          const synced = await syncThread(workspaceId, account.id, t.id);
          messagesSynced += synced.messagesSynced;
        } catch {
          // A single Gmail thread should not prevent the rest of the lead file
          // from loading. The DB read below still returns what is already synced.
        }
      }
    } catch {
      // Same principle at account level: best-effort hydration.
    }
  }

  return { searchedAccounts: accounts.length, threadsSeen, messagesSynced };
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
