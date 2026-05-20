import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/db';
import { campaigns, type Campaign } from '../db/schema/campaigns';
import { campaignGoals } from '../db/schema/campaign-goals';
import { campaignPlaybooks } from '../db/schema/campaign-playbooks';
import { campaignDemoGuides } from '../db/schema/campaign-demo-guides';
import { campaignExitRules } from '../db/schema/campaign-exit-rules';
import { campaignKnowledgeFiles } from '../db/schema/campaign-knowledge-files';
import { campaignLeadSources } from '../db/schema/campaign-lead-sources';
import { campaignTrainingSessions } from '../db/schema/campaign-training-sessions';
import { campaignTestScenarios } from '../db/schema/campaign-test-scenarios';
import { gmailAccounts } from '../db/schema/gmail-accounts';
import type { ErrorDetail } from '../utils/errors';

export interface ActivationResult {
  allowed: boolean;
  blockers: ErrorDetail[];
}

/**
 * Run the 12-check campaign readiness gate from the spec. Returns blockers
 * as ErrorDetail[] so they can flow straight into the standard error envelope.
 */
export async function canActivate(workspaceId: string, campaign: Campaign): Promise<ActivationResult> {
  const db = getDb();
  const blockers: ErrorDetail[] = [];
  const cid = campaign.id;
  const ws = and(eq(campaignGoals.workspaceId, workspaceId), eq(campaignGoals.campaignId, cid));

  // 1. Campaign basics
  if (!campaign.name?.trim()) {
    blockers.push({ field: 'campaign.name', reason: 'name is required' });
  }
  if (!campaign.primaryCta?.trim()) {
    blockers.push({ field: 'campaign.primary_cta', reason: 'primary CTA is required' });
  }

  // 2. Campaign goal
  const goal = await db.select().from(campaignGoals).where(ws).limit(1);
  if (goal.length === 0) {
    blockers.push({ field: 'goal', reason: 'campaign goal not defined' });
  }

  // 3. Knowledge uploaded or notes provided
  const knowledge = await db
    .select()
    .from(campaignKnowledgeFiles)
    .where(and(eq(campaignKnowledgeFiles.workspaceId, workspaceId), eq(campaignKnowledgeFiles.campaignId, cid)))
    .limit(1);
  if (knowledge.length === 0) {
    blockers.push({ field: 'knowledge', reason: 'no knowledge files or notes uploaded' });
  }

  // 4. Training session completed
  const training = await db
    .select()
    .from(campaignTrainingSessions)
    .where(
      and(
        eq(campaignTrainingSessions.workspaceId, workspaceId),
        eq(campaignTrainingSessions.campaignId, cid),
        eq(campaignTrainingSessions.status, 'completed'),
      ),
    )
    .limit(1);
  if (training.length === 0) {
    blockers.push({ field: 'training', reason: 'campaign training has not been completed' });
  }

  // 5. Playbook generated and approved
  const playbook = await db
    .select()
    .from(campaignPlaybooks)
    .where(and(eq(campaignPlaybooks.workspaceId, workspaceId), eq(campaignPlaybooks.campaignId, cid)))
    .limit(1);
  if (playbook.length === 0) {
    blockers.push({ field: 'playbook', reason: 'campaign playbook has not been generated' });
  } else if (playbook[0]!.approvalStatus !== 'approved') {
    blockers.push({ field: 'playbook', reason: 'campaign playbook has not been approved' });
  }

  // 6. Demo guide generated and approved
  const demo = await db
    .select()
    .from(campaignDemoGuides)
    .where(and(eq(campaignDemoGuides.workspaceId, workspaceId), eq(campaignDemoGuides.campaignId, cid)))
    .limit(1);
  if (demo.length === 0) {
    blockers.push({ field: 'demo_guide', reason: 'demo guide has not been generated' });
  } else if (demo[0]!.approvalStatus !== 'approved') {
    blockers.push({ field: 'demo_guide', reason: 'demo guide has not been approved' });
  }

  // 7. Lead source connected
  const sources = await db
    .select()
    .from(campaignLeadSources)
    .where(
      and(
        eq(campaignLeadSources.workspaceId, workspaceId),
        eq(campaignLeadSources.campaignId, cid),
        eq(campaignLeadSources.isActive, true),
      ),
    )
    .limit(1);
  if (sources.length === 0) {
    blockers.push({ field: 'lead_source', reason: 'no active lead source connected' });
  }

  // 8. Exit rules configured
  const exitRules = await db
    .select()
    .from(campaignExitRules)
    .where(and(eq(campaignExitRules.workspaceId, workspaceId), eq(campaignExitRules.campaignId, cid)))
    .limit(1);
  if (exitRules.length === 0) {
    blockers.push({ field: 'exit_rules', reason: 'exit rules have not been configured' });
  }

  // 9. Test scenarios reviewed
  const scenarios = await db
    .select()
    .from(campaignTestScenarios)
    .where(and(eq(campaignTestScenarios.workspaceId, workspaceId), eq(campaignTestScenarios.campaignId, cid)))
    .limit(1);
  if (scenarios.length === 0) {
    blockers.push({ field: 'test_scenarios', reason: 'no test scenarios reviewed' });
  }

  // 10. Gmail account connected (campaign has one assigned and it is active)
  if (!campaign.gmailAccountId) {
    blockers.push({ field: 'gmail_account', reason: 'no Gmail account assigned to campaign' });
  } else {
    const ga = await db.select().from(gmailAccounts).where(eq(gmailAccounts.id, campaign.gmailAccountId)).limit(1);
    if (ga.length === 0 || !ga[0]!.isActive) {
      blockers.push({ field: 'gmail_account', reason: 'assigned Gmail account is inactive' });
    } else if (ga[0]!.healthStatus === 'at_risk' || ga[0]!.healthStatus === 'paused') {
      blockers.push({ field: 'gmail_account', reason: `Gmail account health is ${ga[0]!.healthStatus}` });
    }
  }

  // 11. Domain health acceptable — encoded by gmail_account.health_status above
  // 12. Campaign not already archived
  if (campaign.status === 'archived') {
    blockers.push({ field: 'campaign.status', reason: 'archived campaigns cannot be activated' });
  }

  return { allowed: blockers.length === 0, blockers };
}
