import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/db';
import { campaignGoals, type CampaignGoal, type NewCampaignGoal } from '../db/schema/campaign-goals';
import { campaignExitRules, type CampaignExitRules, type NewCampaignExitRules } from '../db/schema/campaign-exit-rules';
import { campaignPlaybooks, type CampaignPlaybook, type NewCampaignPlaybook } from '../db/schema/campaign-playbooks';
import { campaignDemoGuides, type CampaignDemoGuide, type NewCampaignDemoGuide } from '../db/schema/campaign-demo-guides';
import { campaigns } from '../db/schema/campaigns';
import { workspaces } from '../db/schema/workspaces';
import { getAnthropic } from '../config/anthropic';
import { env } from '../config/env';
import { NotFoundError, AppError } from '../utils/errors';

type Patch<T> = Partial<Omit<T, 'id' | 'workspaceId' | 'campaignId' | 'createdAt'>>;

// -------- GOAL --------

export async function getGoal(workspaceId: string, campaignId: string): Promise<CampaignGoal | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaignGoals)
    .where(and(eq(campaignGoals.workspaceId, workspaceId), eq(campaignGoals.campaignId, campaignId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertGoal(
  workspaceId: string,
  campaignId: string,
  input: Patch<NewCampaignGoal> & { primaryGoal?: string; primaryCta?: string },
): Promise<CampaignGoal> {
  const db = getDb();
  const existing = await getGoal(workspaceId, campaignId);
  if (existing) {
    const rows = await db
      .update(campaignGoals)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(campaignGoals.id, existing.id))
      .returning();
    return rows[0]!;
  }
  if (!input.primaryGoal || !input.primaryCta) {
    throw new NotFoundError('Goal does not exist yet; first create must include primary_goal and primary_cta');
  }
  const rows = await db
    .insert(campaignGoals)
    .values({
      workspaceId,
      campaignId,
      primaryGoal: input.primaryGoal,
      primaryCta: input.primaryCta,
      ...input,
    } as NewCampaignGoal)
    .returning();
  return rows[0]!;
}

// -------- EXIT RULES --------

export async function getExitRules(workspaceId: string, campaignId: string): Promise<CampaignExitRules | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaignExitRules)
    .where(and(eq(campaignExitRules.workspaceId, workspaceId), eq(campaignExitRules.campaignId, campaignId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertExitRules(
  workspaceId: string,
  campaignId: string,
  input: Patch<NewCampaignExitRules>,
): Promise<CampaignExitRules> {
  const db = getDb();
  const existing = await getExitRules(workspaceId, campaignId);
  if (existing) {
    const rows = await db
      .update(campaignExitRules)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(campaignExitRules.id, existing.id))
      .returning();
    return rows[0]!;
  }
  const rows = await db
    .insert(campaignExitRules)
    .values({ workspaceId, campaignId, ...input } as NewCampaignExitRules)
    .returning();
  return rows[0]!;
}

// -------- PLAYBOOK --------

export async function getPlaybook(workspaceId: string, campaignId: string): Promise<CampaignPlaybook | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaignPlaybooks)
    .where(and(eq(campaignPlaybooks.workspaceId, workspaceId), eq(campaignPlaybooks.campaignId, campaignId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertPlaybook(
  workspaceId: string,
  campaignId: string,
  input: Patch<NewCampaignPlaybook>,
): Promise<CampaignPlaybook> {
  const db = getDb();
  const existing = await getPlaybook(workspaceId, campaignId);
  if (existing) {
    // Editing an approved playbook drops it back to draft; user must re-approve.
    const nextApproval = existing.approvalStatus === 'approved' ? 'draft' : existing.approvalStatus;
    const rows = await db
      .update(campaignPlaybooks)
      .set({ ...input, approvalStatus: nextApproval, updatedAt: new Date() })
      .where(eq(campaignPlaybooks.id, existing.id))
      .returning();
    return rows[0]!;
  }
  const rows = await db
    .insert(campaignPlaybooks)
    .values({ workspaceId, campaignId, ...input } as NewCampaignPlaybook)
    .returning();
  return rows[0]!;
}

export async function approvePlaybook(workspaceId: string, campaignId: string): Promise<CampaignPlaybook> {
  const db = getDb();
  const existing = await getPlaybook(workspaceId, campaignId);
  if (!existing) throw new NotFoundError('Playbook not found');
  const rows = await db
    .update(campaignPlaybooks)
    .set({ approvalStatus: 'approved', approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(campaignPlaybooks.id, existing.id))
    .returning();
  return rows[0]!;
}

// -------- DEMO GUIDE --------

export async function getDemoGuide(workspaceId: string, campaignId: string): Promise<CampaignDemoGuide | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaignDemoGuides)
    .where(and(eq(campaignDemoGuides.workspaceId, workspaceId), eq(campaignDemoGuides.campaignId, campaignId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertDemoGuide(
  workspaceId: string,
  campaignId: string,
  input: Patch<NewCampaignDemoGuide>,
): Promise<CampaignDemoGuide> {
  const db = getDb();
  const existing = await getDemoGuide(workspaceId, campaignId);
  if (existing) {
    const nextApproval = existing.approvalStatus === 'approved' ? 'draft' : existing.approvalStatus;
    const rows = await db
      .update(campaignDemoGuides)
      .set({ ...input, approvalStatus: nextApproval, updatedAt: new Date() })
      .where(eq(campaignDemoGuides.id, existing.id))
      .returning();
    return rows[0]!;
  }
  const rows = await db
    .insert(campaignDemoGuides)
    .values({ workspaceId, campaignId, ...input } as NewCampaignDemoGuide)
    .returning();
  return rows[0]!;
}

export async function approveDemoGuide(workspaceId: string, campaignId: string): Promise<CampaignDemoGuide> {
  const db = getDb();
  const existing = await getDemoGuide(workspaceId, campaignId);
  if (!existing) throw new NotFoundError('Demo guide not found');
  const rows = await db
    .update(campaignDemoGuides)
    .set({ approvalStatus: 'approved', approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(campaignDemoGuides.id, existing.id))
    .returning();
  return rows[0]!;
}

// -------- GOAL FIELD SUGGESTIONS (light AI, no ai_actions logging) --------

export const SUGGESTABLE_GOAL_FIELDS = [
  'primaryGoal',
  'secondaryGoal',
  'primaryCta',
  'successDefinition',
  'qualifiedReplyDefinition',
  'offerSummary',
  'handoffTriggers',
  'autoReplyBoundaries',
] as const;
export type SuggestableGoalField = (typeof SUGGESTABLE_GOAL_FIELDS)[number];

const FIELD_PROMPTS: Record<SuggestableGoalField, string> = {
  primaryGoal:
    'The single concrete outcome this campaign should produce. One sentence, action-oriented (e.g. "book 25 qualified discovery calls per month with mid-market logistics ops leaders"). Avoid vague verbs like "engage" or "build relationships".',
  secondaryGoal:
    'A nice-to-have outcome the AI can pursue when the primary goal is not in reach. One sentence.',
  primaryCta:
    'The exact ask in the first email. One short imperative phrase the AI will paraphrase (e.g. "book a 15-minute intro call this week"). Concrete, no hedging.',
  successDefinition:
    'What does a successful run of this campaign look like at the end of the quarter? Numeric where possible (calls booked, deals influenced, pipeline created).',
  qualifiedReplyDefinition:
    'What signals qualify an inbound reply as worth pursuing vs. a polite acknowledgement? Be specific about intent signals (e.g. "asks about pricing, timing, integrations, or implementation").',
  offerSummary:
    'What the AI is actually offering, in one short paragraph. Concrete: what they get, in what timeframe, at what cost (or "by discussion"). The AI uses this verbatim.',
  handoffTriggers:
    'Conditions that should escalate a thread to a human owner. Plain prose list (e.g. "asked for custom pricing, mentioned legal/SOW, asked specific implementation questions, sentiment turned hostile").',
  autoReplyBoundaries:
    'What the AI must NEVER do or say in this campaign. Hard nos. Things only humans can answer. Claims it must not make. Be strict — these become guardrails.',
};

/**
 * Ask Claude for a one-field suggestion. Uses Haiku, ~300 tokens output, no
 * ai_actions row (this is a UI helper, not a tracked task). Returns plain
 * text the user can edit before saving.
 */
export async function suggestGoalField(input: {
  workspaceId: string;
  campaignId: string;
  field: SuggestableGoalField;
}): Promise<{ suggestion: string }> {
  const db = getDb();

  // Pull workspace + campaign + existing goal so the suggestion is grounded
  const wsRow = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  const ws = wsRow[0];
  if (!ws) throw new NotFoundError('Workspace not found');

  const camRow = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, input.workspaceId), eq(campaigns.id, input.campaignId)))
    .limit(1);
  const campaign = camRow[0];
  if (!campaign) throw new NotFoundError('Campaign not found');

  const goal = await getGoal(input.workspaceId, input.campaignId);

  const fieldGuidance = FIELD_PROMPTS[input.field];
  const context = [
    `Workspace: ${ws.name} (${ws.companyName})`,
    ws.industry ? `Industry: ${ws.industry}` : null,
    `Campaign: ${campaign.name}`,
    campaign.campaignType ? `Type: ${campaign.campaignType}` : null,
    campaign.targetAudience ? `Audience: ${campaign.targetAudience}` : null,
    campaign.offer ? `Offer: ${campaign.offer}` : null,
    goal?.primaryGoal && input.field !== 'primaryGoal'
      ? `Existing primary goal: ${goal.primaryGoal}`
      : null,
    goal?.primaryCta && input.field !== 'primaryCta' ? `Existing CTA: ${goal.primaryCta}` : null,
    goal?.successDefinition && input.field !== 'successDefinition'
      ? `Success: ${goal.successDefinition}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const anthropic = getAnthropic();
  const response = await anthropic.messages.create({
    model: env().ANTHROPIC_MODEL_LIGHT,
    max_tokens: 400,
    system:
      'You are a senior B2B outbound consultant helping configure an AI sales campaign. You write the field exactly the way the operator should write it themselves — first person plural ("we", "our") when relevant, no preamble, no "here\'s a suggestion" framing, no headers. Just the field content. Concise: one to three sentences unless the field genuinely needs more.',
    messages: [
      {
        role: 'user',
        content: `## Campaign context\n\n${context || '(no context filled in yet)'}\n\n## Field to draft\n\n**${input.field}**\n\n${fieldGuidance}\n\nWrite the suggested value for this field now, ready to paste into the form. Output ONLY the field content — no quotes, no preamble.`,
      },
    ],
  });

  const message = response as { content: Array<{ type: string; text?: string }> };
  const text = message.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();

  if (!text) throw new AppError('AI returned empty suggestion', 502);
  return { suggestion: text };
}
