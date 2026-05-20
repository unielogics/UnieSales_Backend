/**
 * DNS-based domain health for Gmail accounts: SPF / DKIM / DMARC / MX.
 * DKIM check uses a default Google selector (`google._domainkey`). Real domains
 * may use other selectors — the API exposes a check endpoint that accepts a
 * selector override.
 */
import { promises as dns } from 'node:dns';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../config/db';
import { gmailAccounts } from '../db/schema/gmail-accounts';
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

export async function checkAndPersist(input: {
  workspaceId: string;
  gmailAccountId?: string;
  domain: string;
  dkimSelector?: string;
}): Promise<DomainHealthCheck> {
  const result = await checkDomain(input.domain, input.dkimSelector);
  const db = getDb();
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
      healthScore: result.healthScore,
      recommendation: result.recommendation,
    } as NewDomainHealthCheck)
    .returning();

  // Sync the high-level health_status on the gmail_account
  if (input.gmailAccountId) {
    const healthStatus = result.healthScore >= 80 ? 'healthy' : result.healthScore >= 50 ? 'warning' : 'at_risk';
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

export async function checkAllActive(): Promise<{ checked: number; failed: number }> {
  const db = getDb();
  const accounts = await db.select().from(gmailAccounts).where(and(eq(gmailAccounts.isActive, true)));
  let checked = 0;
  let failed = 0;
  for (const a of accounts) {
    if (!a.domain) continue;
    try {
      await checkAndPersist({ workspaceId: a.workspaceId, gmailAccountId: a.id, domain: a.domain });
      checked++;
    } catch {
      failed++;
    }
  }
  return { checked, failed };
}
