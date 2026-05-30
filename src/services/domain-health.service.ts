/**
 * DNS-based domain health for Gmail accounts: SPF / DKIM / DMARC / MX.
 * DKIM check uses a default Google selector (`google._domainkey`). Real domains
 * may use other selectors — the API exposes a check endpoint that accepts a
 * selector override.
 */
import { promises as dns } from 'node:dns';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { gmailAccounts } from '../db/schema/gmail-accounts';
import { workspaces } from '../db/schema/workspaces';
import { workspaceMembers } from '../db/schema/workspace-members';
import { emailMessages } from '../db/schema/email-messages';
import { domainHealthChecks, type DomainHealthCheck, type NewDomainHealthCheck } from '../db/schema/domain-health-checks';

export type CheckStatus = 'pass' | 'fail' | 'unknown';

export interface DomainCheckResult {
  domain: string;
  spfStatus: CheckStatus;
  dkimStatus: CheckStatus;
  dmarcStatus: CheckStatus;
  mxStatus: CheckStatus;
  healthScore: number; // 0–100
  recommendation: string;
  spfRecord?: string;
  dmarcRecord?: string;
  mxRecords?: string[];
}

const GOOGLE_DKIM_SELECTOR = 'google';

async function txtAt(name: string): Promise<string[]> {
  try {
    const recs = await dns.resolveTxt(name);
    return recs.map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

async function mxAt(name: string): Promise<string[]> {
  try {
    const recs = await dns.resolveMx(name);
    return recs.map((r) => r.exchange.toLowerCase());
  } catch {
    return [];
  }
}

export async function checkDomain(domain: string, dkimSelector = GOOGLE_DKIM_SELECTOR): Promise<DomainCheckResult> {
  const cleaned = domain.trim().toLowerCase();

  const [spfRecords, dmarcRecords, dkimRecords, mxRecords] = await Promise.all([
    txtAt(cleaned),
    txtAt(`_dmarc.${cleaned}`),
    txtAt(`${dkimSelector}._domainkey.${cleaned}`),
    mxAt(cleaned),
  ]);

  const spfRecord = spfRecords.find((r) => /v=spf1/i.test(r));
  const dmarcRecord = dmarcRecords.find((r) => /v=DMARC1/i.test(r));
  const dkimRecord = dkimRecords.find((r) => /v=DKIM1|p=/i.test(r));

  const spfStatus: CheckStatus = spfRecord ? 'pass' : 'fail';
  const dmarcStatus: CheckStatus = dmarcRecord ? 'pass' : 'fail';
  const dkimStatus: CheckStatus = dkimRecord ? 'pass' : 'unknown';
  const mxStatus: CheckStatus =
    mxRecords.some((m) => m.includes('google.com') || m.includes('googlemail.com')) ? 'pass' : mxRecords.length > 0 ? 'fail' : 'fail';

  let score = 0;
  if (spfStatus === 'pass') score += 30;
  if (dmarcStatus === 'pass') score += 30;
  if (dkimStatus === 'pass') score += 20;
  if (mxStatus === 'pass') score += 20;

  const issues: string[] = [];
  if (spfStatus !== 'pass') issues.push('SPF record missing or invalid');
  if (dmarcStatus !== 'pass') issues.push('DMARC record missing');
  if (dkimStatus !== 'pass') issues.push(`DKIM record not found at ${dkimSelector}._domainkey.${cleaned} (selector may differ)`);
  if (mxStatus !== 'pass') issues.push('MX records do not point to Google');

  const recommendation = issues.length === 0 ? 'All checks pass' : issues.join('; ');

  return {
    domain: cleaned,
    spfStatus,
    dkimStatus,
    dmarcStatus,
    mxStatus,
    healthScore: score,
    recommendation,
    spfRecord,
    dmarcRecord,
    mxRecords,
  };
}

export interface ActivityMetrics {
  sendVolume: number;
  bounceRate: number; // 0–1
  replyRate: number; // 0–1
  unsubscribeRate: number; // 0–1
}

const ACTIVITY_WINDOW_DAYS = 14;

/**
 * Real sending activity for a Gmail account over a rolling window — drawn from
 * email_messages (outbound counts + classified inbound). This is what makes
 * reputation respond to behaviour rather than just DNS.
 */
export async function computeAccountActivity(
  workspaceId: string,
  accountEmail: string,
): Promise<ActivityMetrics> {
  const db = getDb();
  const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 86_400_000);
  const like = `%${accountEmail.toLowerCase()}%`;

  const outRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.workspaceId, workspaceId),
        eq(emailMessages.direction, 'outbound'),
        gte(emailMessages.createdAt, since),
        sql`lower(${emailMessages.fromEmail}) like ${like}`,
      ),
    );
  const sendVolume = outRows[0]?.n ?? 0;

  const inboundRows = await db
    .select({ cls: emailMessages.aiClassification, n: sql<number>`count(*)::int` })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.workspaceId, workspaceId),
        eq(emailMessages.direction, 'inbound'),
        gte(emailMessages.createdAt, since),
        sql`lower(${emailMessages.toEmail}) like ${like}`,
      ),
    )
    .groupBy(emailMessages.aiClassification);

  let bounces = 0;
  let unsub = 0;
  let replies = 0;
  for (const r of inboundRows) {
    const c = r.cls ?? '';
    if (c === 'bounce' || c === 'close_bounced') bounces += r.n;
    else if (c === 'unsubscribe' || c === 'close_unsubscribed') unsub += r.n;
    else replies += r.n;
  }
  const denom = sendVolume || 1;
  return {
    sendVolume,
    bounceRate: bounces / denom,
    replyRate: replies / denom,
    unsubscribeRate: unsub / denom,
  };
}

/** Blend DNS score with live activity. Bounces are the dominant penalty. */
function blendScore(dnsScore: number, m: ActivityMetrics): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = dnsScore;
  if (m.sendVolume >= 5) {
    if (m.bounceRate >= 0.05) {
      score -= 40;
      notes.push(`Bounce rate ${(m.bounceRate * 100).toFixed(1)}% — critical, pause sends and warm up`);
    } else if (m.bounceRate >= 0.02) {
      score -= 20;
      notes.push(`Bounce rate ${(m.bounceRate * 100).toFixed(1)}% — elevated, clean the list`);
    } else if (m.bounceRate >= 0.01) {
      score -= 8;
      notes.push(`Bounce rate ${(m.bounceRate * 100).toFixed(1)}% — watch it`);
    }
    if (m.unsubscribeRate >= 0.02) {
      score -= 10;
      notes.push(`Unsubscribe rate ${(m.unsubscribeRate * 100).toFixed(1)}% — high`);
    }
    if (m.replyRate >= 0.1) {
      score += 5;
      notes.push(`Healthy reply rate ${(m.replyRate * 100).toFixed(0)}%`);
    }
  } else {
    notes.push('Low send volume — reputation based on DNS only');
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), notes };
}

export async function checkAndPersist(input: {
  workspaceId: string;
  gmailAccountId?: string;
  domain: string;
  dkimSelector?: string;
  accountEmail?: string;
}): Promise<DomainHealthCheck> {
  const result = await checkDomain(input.domain, input.dkimSelector);
  const db = getDb();

  // Resolve the account email so we can pull real activity.
  let accountEmail = input.accountEmail;
  if (!accountEmail && input.gmailAccountId) {
    const a = await db
      .select({ email: gmailAccounts.email })
      .from(gmailAccounts)
      .where(eq(gmailAccounts.id, input.gmailAccountId))
      .limit(1);
    accountEmail = a[0]?.email;
  }

  const metrics = accountEmail
    ? await computeAccountActivity(input.workspaceId, accountEmail)
    : { sendVolume: 0, bounceRate: 0, replyRate: 0, unsubscribeRate: 0 };
  const blended = blendScore(result.healthScore, metrics);
  const recommendation = [result.recommendation, ...blended.notes].filter(Boolean).join('; ');

  const [row] = await db
    .insert(domainHealthChecks)
    .values({
      workspaceId: input.workspaceId,
      gmailAccountId: input.gmailAccountId ?? null,
      domain: result.domain,
      spfStatus: result.spfStatus,
      dkimStatus: result.dkimStatus,
      dmarcStatus: result.dmarcStatus,
      mxStatus: result.mxStatus,
      bounceRate: metrics.bounceRate.toFixed(4),
      unsubscribeRate: metrics.unsubscribeRate.toFixed(4),
      replyRate: metrics.replyRate.toFixed(4),
      sendVolume: metrics.sendVolume,
      healthScore: blended.score,
      recommendation,
    } as NewDomainHealthCheck)
    .returning();

  // Sync the high-level health_status on the gmail_account
  if (input.gmailAccountId) {
    const healthStatus = blended.score >= 80 ? 'healthy' : blended.score >= 50 ? 'warning' : 'at_risk';
    await db
      .update(gmailAccounts)
      .set({ healthStatus, updatedAt: new Date() })
      .where(eq(gmailAccounts.id, input.gmailAccountId));
  }
  return row!;
}

export async function latestForWorkspace(workspaceId: string): Promise<DomainHealthCheck[]> {
  const db = getDb();
  return db
    .select()
    .from(domainHealthChecks)
    .where(eq(domainHealthChecks.workspaceId, workspaceId))
    .orderBy(desc(domainHealthChecks.checkedAt))
    .limit(50);
}

export interface AccountHealth {
  id: string;
  email: string;
  domain: string | null;
  workspaceId: string;
  workspaceName: string;
  healthStatus: string;
  latestCheck: DomainHealthCheck | null;
}

export interface SystemDomainHealth {
  accounts: AccountHealth[];
  summary: {
    total: number;
    healthy: number;
    warning: number;
    atRisk: number;
    worst: 'healthy' | 'warning' | 'at_risk' | 'unknown';
  };
}

/**
 * Sender reputation across EVERY workspace the user belongs to — the system is
 * monitored as a whole, not per workspace.
 */
export async function domainHealthForUser(userId: string): Promise<SystemDomainHealth> {
  const db = getDb();
  const empty: SystemDomainHealth = {
    accounts: [],
    summary: { total: 0, healthy: 0, warning: 0, atRisk: 0, worst: 'unknown' },
  };

  const memberRows = await db
    .select({ wid: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  const wids = memberRows.map((m) => m.wid);
  if (wids.length === 0) return empty;

  const wsRows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(inArray(workspaces.id, wids));
  const wsName = new Map(wsRows.map((w) => [w.id, w.name]));

  const accounts = await db
    .select()
    .from(gmailAccounts)
    .where(and(inArray(gmailAccounts.workspaceId, wids), eq(gmailAccounts.isActive, true)));

  const out: AccountHealth[] = [];
  for (const a of accounts) {
    const checks = await db
      .select()
      .from(domainHealthChecks)
      .where(eq(domainHealthChecks.gmailAccountId, a.id))
      .orderBy(desc(domainHealthChecks.checkedAt))
      .limit(1);
    out.push({
      id: a.id,
      email: a.email,
      domain: a.domain,
      workspaceId: a.workspaceId,
      workspaceName: wsName.get(a.workspaceId) ?? '—',
      healthStatus: a.healthStatus,
      latestCheck: checks[0] ?? null,
    });
  }

  let healthy = 0;
  let warning = 0;
  let atRisk = 0;
  for (const a of out) {
    if (a.healthStatus === 'healthy') healthy++;
    else if (a.healthStatus === 'warning') warning++;
    else if (a.healthStatus === 'at_risk' || a.healthStatus === 'paused') atRisk++;
  }
  const worst: SystemDomainHealth['summary']['worst'] =
    atRisk > 0 ? 'at_risk' : warning > 0 ? 'warning' : healthy > 0 ? 'healthy' : 'unknown';

  return {
    accounts: out,
    summary: { total: out.length, healthy, warning, atRisk, worst },
  };
}

export async function checkAllActive(): Promise<{ checked: number; failed: number }> {
  const db = getDb();
  const accounts = await db.select().from(gmailAccounts).where(and(eq(gmailAccounts.isActive, true)));
  let checked = 0;
  let failed = 0;
  for (const a of accounts) {
    if (!a.domain) continue;
    try {
      await checkAndPersist({
        workspaceId: a.workspaceId,
        gmailAccountId: a.id,
        domain: a.domain,
        accountEmail: a.email,
      });
      checked++;
    } catch {
      failed++;
    }
  }
  return { checked, failed };
}
