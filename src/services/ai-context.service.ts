import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../config/db';
import { workspaces, type Workspace } from '../db/schema/workspaces';
import { campaigns, type Campaign } from '../db/schema/campaigns';
import { campaignPlaybooks, type CampaignPlaybook } from '../db/schema/campaign-playbooks';
import { campaignGoals } from '../db/schema/campaign-goals';
import { campaignExitRules } from '../db/schema/campaign-exit-rules';
import { campaignKnowledgeFiles } from '../db/schema/campaign-knowledge-files';
import { leads, type Lead } from '../db/schema/leads';
import { emailThreads, type EmailThread } from '../db/schema/email-threads';
import { emailMessages, type EmailMessage } from '../db/schema/email-messages';

export interface AiContextRequest {
  workspaceId: string;
  campaignId?: string | null;
  leadId?: string | null;
  threadId?: string | null;
  knowledgeLimit?: number;
  threadMessageLimit?: number;
}

export interface AiContextPackage {
  workspace: {
    id: string;
    name: string;
    company_name: string;
    brand: string | null;
    industry: string | null;
    auto_reply_confidence_threshold: number;
    auto_reply_enabled: boolean;
  };
  campaign: {
    id: string;
    name: string;
    primary_goal: string | null;
    primary_cta: string | null;
    target_audience: string | null;
    status: string;
  } | null;
  playbook: {
    campaign_thesis: string | null;
    buyer_persona: string | null;
    primary_hook: string | null;
    primary_cta: string | null;
    objection_map: unknown;
    value_proposition: string | null;
    target_pains: string | null;
    allowed_claims: string | null;
    prohibited_claims: string | null;
    ai_operating_instructions: string | null;
  } | null;
  knowledge: Array<{ title: string; document_type: string | null; summary: string }>;
  lead: {
    id: string;
    company_name: string | null;
    contact_name: string | null;
    email: string;
    website: string | null;
    title: string | null;
    segment: string | null;
    lead_score: number;
    status: string;
    personalization: string | null;
    pain_angle: string | null;
  } | null;
  thread: {
    subject: string | null;
    messages: Array<{
      direction: string | null;
      from: string | null;
      subject: string | null;
      body: string;
      created_at: string;
    }>;
  } | null;
  rules: {
    handoff_triggers: string | null;
    prohibited_claims: string | null;
    exit_rules: {
      max_email_attempts: number | null;
      max_days_in_sequence: number | null;
      max_no_reply_followups: number | null;
    } | null;
  };
}

const KNOWLEDGE_SUMMARY_MAX_CHARS = 800;
const THREAD_BODY_MAX_CHARS = 1500;

function trim(s: string | null | undefined, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max) + '…';
}

export async function buildContext(req: AiContextRequest): Promise<AiContextPackage> {
  const db = getDb();

  const wsRow = (await db.select().from(workspaces).where(eq(workspaces.id, req.workspaceId)).limit(1))[0];
  if (!wsRow) throw new Error(`workspace not found: ${req.workspaceId}`);

  let campaign: Campaign | null = null;
  if (req.campaignId) {
    const rows = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.workspaceId, req.workspaceId), eq(campaigns.id, req.campaignId)))
      .limit(1);
    campaign = rows[0] ?? null;
  }

  let playbook: CampaignPlaybook | null = null;
  let goalRow: typeof campaignGoals.$inferSelect | undefined;
  let exitRulesRow: typeof campaignExitRules.$inferSelect | undefined;
  if (campaign) {
    const pbRows = await db
      .select()
      .from(campaignPlaybooks)
      .where(
        and(eq(campaignPlaybooks.workspaceId, req.workspaceId), eq(campaignPlaybooks.campaignId, campaign.id)),
      )
      .limit(1);
    playbook = pbRows[0] ?? null;

    const goalRows = await db
      .select()
      .from(campaignGoals)
      .where(and(eq(campaignGoals.workspaceId, req.workspaceId), eq(campaignGoals.campaignId, campaign.id)))
      .limit(1);
    goalRow = goalRows[0];

    const exitRows = await db
      .select()
      .from(campaignExitRules)
      .where(and(eq(campaignExitRules.workspaceId, req.workspaceId), eq(campaignExitRules.campaignId, campaign.id)))
      .limit(1);
    exitRulesRow = exitRows[0];
  }

  let knowledge: AiContextPackage['knowledge'] = [];
  if (campaign) {
    const klimit = req.knowledgeLimit ?? 5;
    const kRows = await db
      .select()
      .from(campaignKnowledgeFiles)
      .where(
        and(
          eq(campaignKnowledgeFiles.workspaceId, req.workspaceId),
          eq(campaignKnowledgeFiles.campaignId, campaign.id),
          eq(campaignKnowledgeFiles.isActive, true),
        ),
      )
      .limit(klimit);
    knowledge = kRows.map((k) => ({
      title: k.fileName,
      document_type: k.documentType,
      summary: trim(k.summary ?? k.extractedText, KNOWLEDGE_SUMMARY_MAX_CHARS),
    }));
  }

  let lead: Lead | null = null;
  if (req.leadId) {
    const rows = await db
      .select()
      .from(leads)
      .where(and(eq(leads.workspaceId, req.workspaceId), eq(leads.id, req.leadId)))
      .limit(1);
    lead = rows[0] ?? null;
  }

  let thread: AiContextPackage['thread'] = null;
  if (req.threadId) {
    const tRows = await db
      .select()
      .from(emailThreads)
      .where(and(eq(emailThreads.workspaceId, req.workspaceId), eq(emailThreads.id, req.threadId)))
      .limit(1);
    const t: EmailThread | undefined = tRows[0];
    if (t) {
      const tlimit = req.threadMessageLimit ?? 10;
      const msgs: EmailMessage[] = await db
        .select()
        .from(emailMessages)
        .where(
          and(eq(emailMessages.workspaceId, req.workspaceId), eq(emailMessages.emailThreadId, t.id)),
        )
        .orderBy(desc(emailMessages.createdAt))
        .limit(tlimit);
      thread = {
        subject: t.subject,
        messages: msgs.reverse().map((m) => ({
          direction: m.direction,
          from: m.fromEmail,
          subject: m.subject,
          body: trim(m.body, THREAD_BODY_MAX_CHARS),
          created_at: m.createdAt.toISOString(),
        })),
      };
    }
  }

  return {
    workspace: {
      id: wsRow.id,
      name: wsRow.name,
      company_name: wsRow.companyName,
      brand: wsRow.brandName,
      industry: wsRow.industry,
      auto_reply_confidence_threshold: Number(wsRow.autoReplyConfidenceThreshold),
      auto_reply_enabled: wsRow.autoReplyEnabled,
    },
    campaign: campaign
      ? {
          id: campaign.id,
          name: campaign.name,
          primary_goal: goalRow?.primaryGoal ?? campaign.goalSummary,
          primary_cta: goalRow?.primaryCta ?? campaign.primaryCta,
          target_audience: goalRow?.targetAudience ?? campaign.targetAudience,
          status: campaign.status,
        }
      : null,
    playbook: playbook
      ? {
          campaign_thesis: playbook.campaignThesis,
          buyer_persona: playbook.buyerPersona,
          primary_hook: playbook.primaryHook,
          primary_cta: playbook.primaryCta,
          objection_map: playbook.objectionMap,
          value_proposition: playbook.valueProposition,
          target_pains: playbook.targetPains,
          allowed_claims: playbook.allowedClaims,
          prohibited_claims: playbook.prohibitedClaims,
          ai_operating_instructions: playbook.aiOperatingInstructions,
        }
      : null,
    knowledge,
    lead: lead
      ? {
          id: lead.id,
          company_name: lead.companyName,
          contact_name: lead.contactName,
          email: lead.email,
          website: lead.website,
          title: lead.title,
          segment: lead.segment,
          lead_score: lead.leadScore,
          status: lead.status,
          personalization: lead.personalization,
          pain_angle: lead.painAngle,
        }
      : null,
    thread,
    rules: {
      handoff_triggers: goalRow?.handoffTriggers ?? null,
      prohibited_claims:
        playbook?.prohibitedClaims ?? goalRow?.prohibitedClaims ?? null,
      exit_rules: exitRulesRow
        ? {
            max_email_attempts: exitRulesRow.maxEmailAttempts,
            max_days_in_sequence: exitRulesRow.maxDaysInSequence,
            max_no_reply_followups: exitRulesRow.maxNoReplyFollowups,
          }
        : null,
    },
  };
}
