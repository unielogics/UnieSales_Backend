/**
 * Run synthetic reply scenarios through the campaign's playbook to give the
 * operator a preview of how the AI will actually respond before they launch.
 * Each scenario is a hardcoded inbound reply representing a common pattern;
 * we ask Haiku to classify it + recommend an action + draft a response.
 */
import { z } from 'zod';
import { getDb } from '../config/db';
import { and, eq } from 'drizzle-orm';
import { campaigns } from '../db/schema/campaigns';
import { campaignPlaybooks } from '../db/schema/campaign-playbooks';
import { campaignGoals } from '../db/schema/campaign-goals';
import { workspaces } from '../db/schema/workspaces';
import { getAnthropic } from '../config/anthropic';
import { env } from '../config/env';
import { ConflictError, NotFoundError, AppError } from '../utils/errors';

export interface TestScenario {
  key: string;
  label: string;
  inboundBody: string;
}

const SCENARIOS: TestScenario[] = [
  {
    key: 'interested',
    label: 'Interested — wants a call',
    inboundBody:
      'This actually looks really interesting and aligned with what we\'re evaluating right now. Can we set something up next week? Tuesday or Thursday afternoon work best on my end.',
  },
  {
    key: 'pricing',
    label: 'Pricing question — budget gate',
    inboundBody:
      'Before we go further I need to understand pricing. Can you send over your pricing or a typical engagement range? We have a budget process and I can\'t move forward without numbers.',
  },
  {
    key: 'wrong_person',
    label: 'Wrong person — referral',
    inboundBody:
      'I\'m not the right person for this — you want Jane Smith on our procurement team, jane.smith@example.com. She handles all the outbound vendor decisions.',
  },
  {
    key: 'just_renewed',
    label: 'Objection — just renewed',
    inboundBody:
      'We just signed a 2-year renewal with our current vendor last month so we\'re locked in for a while. Probably worth circling back in early 2028 when we\'re evaluating again.',
  },
  {
    key: 'hostile',
    label: 'Hostile — opt out',
    inboundBody:
      'Please stop emailing me. This is not relevant and I\'ve told other vendors the same. Take me off your list.',
  },
];

export interface TestScenarioResult {
  key: string;
  label: string;
  inboundBody: string;
  classification: string;
  recommended_action: 'auto_send_reply' | 'draft_for_review' | 'handoff_to_human' | 'stop_sequence';
  confidence: number;
  draft_reply: string | null;
  rules_used: string[];
  reasoning: string;
}

const ScenarioOutputSchema = z.object({
  classification: z.string(),
  recommended_action: z.enum([
    'auto_send_reply',
    'draft_for_review',
    'handoff_to_human',
    'stop_sequence',
  ]),
  confidence: z.number().min(0).max(1),
  draft_reply: z.string().nullable(),
  rules_used: z.array(z.string()),
  reasoning: z.string(),
});

export async function runTest(input: {
  workspaceId: string;
  campaignId: string;
}): Promise<{ ran: number; results: TestScenarioResult[] }> {
  const db = getDb();

  // Load campaign + playbook + goal + workspace as context
  const wsRow = (
    await db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1)
  )[0];
  if (!wsRow) throw new NotFoundError('Workspace not found');

  const camRow = (
    await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.workspaceId, input.workspaceId), eq(campaigns.id, input.campaignId)))
      .limit(1)
  )[0];
  if (!camRow) throw new NotFoundError('Campaign not found');

  const pbRow = (
    await db
      .select()
      .from(campaignPlaybooks)
      .where(
        and(
          eq(campaignPlaybooks.workspaceId, input.workspaceId),
          eq(campaignPlaybooks.campaignId, input.campaignId),
        ),
      )
      .limit(1)
  )[0];
  if (!pbRow) {
    throw new ConflictError('No playbook yet — generate one before running tests', [
      { field: 'playbook', reason: 'required' },
    ]);
  }

  const goalRow = (
    await db
      .select()
      .from(campaignGoals)
      .where(
        and(
          eq(campaignGoals.workspaceId, input.workspaceId),
          eq(campaignGoals.campaignId, input.campaignId),
        ),
      )
      .limit(1)
  )[0];

  // Compact playbook representation for the prompt
  const playbookSummary = {
    campaign_thesis: pbRow.campaignThesis,
    buyer_persona: pbRow.buyerPersona,
    primary_hook: pbRow.primaryHook,
    primary_cta: pbRow.primaryCta,
    allowed_claims: pbRow.allowedClaims,
    prohibited_claims: pbRow.prohibitedClaims,
    handoff_rules: pbRow.handoffRules,
    exit_rules: pbRow.exitRules,
    ai_operating_instructions: pbRow.aiOperatingInstructions,
  };

  const goalSummary = goalRow
    ? {
        primary_goal: goalRow.primaryGoal,
        primary_cta: goalRow.primaryCta,
        handoff_triggers: goalRow.handoffTriggers,
        auto_reply_boundaries: goalRow.autoReplyBoundaries,
      }
    : null;

  const anthropic = getAnthropic();
  const results: TestScenarioResult[] = [];

  // Run scenarios sequentially (5 calls, ~2s each on Haiku — keeps log clean)
  for (const scenario of SCENARIOS) {
    const userPrompt = `## Campaign
Workspace: ${wsRow.name} (${wsRow.companyName})
Campaign: ${camRow.name} (${camRow.campaignType ?? 'unspecified type'})
Audience: ${camRow.targetAudience ?? '(not set)'}
Offer: ${camRow.offer ?? '(not set)'}

## Goal
${JSON.stringify(goalSummary, null, 2)}

## Playbook
${JSON.stringify(playbookSummary, null, 2)}

## Inbound reply to classify

Subject (continued): Re: ${camRow.name}
Body:
${scenario.inboundBody}

## Your task

Classify this reply and decide how the AI should respond. Apply the playbook strictly — if the inbound matches a handoff rule, recommend handoff_to_human. If it matches an exit/opt-out signal, recommend stop_sequence. If it's a clean qualified reply that the AI can address using only allowed_claims, recommend auto_send_reply with a draft. If it's interesting but needs human judgement, recommend draft_for_review.

Return a single JSON object with this shape:

{
  "classification": "short label, e.g. interested|pricing_question|wrong_person|just_renewed|hostile_opt_out",
  "recommended_action": "auto_send_reply" | "draft_for_review" | "handoff_to_human" | "stop_sequence",
  "confidence": 0.0 to 1.0,
  "draft_reply": "the reply body the AI would send, or null if no reply (e.g. stop_sequence)",
  "rules_used": ["short phrases naming which playbook rules informed this decision"],
  "reasoning": "one paragraph explaining why"
}

Output ONLY the JSON. No prose, no markdown fence.`;

    let parsed: z.infer<typeof ScenarioOutputSchema>;
    try {
      const res = await anthropic.messages.create({
        model: env().ANTHROPIC_MODEL_LIGHT,
        max_tokens: 800,
        system:
          'You are the AI reply classifier for an outbound sales platform. You apply the campaign playbook strictly. You write replies in the same voice the playbook implies. You never invent pricing, terms, or guarantees not in allowed_claims.',
        messages: [{ role: 'user', content: userPrompt }],
      });
      const message = res as { content: Array<{ type: string; text?: string }> };
      const text = message.content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('')
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();
      const json = JSON.parse(text) as unknown;
      parsed = ScenarioOutputSchema.parse(json);
    } catch (err) {
      // Per-scenario failure shouldn't kill the whole run — surface it inline
      const msg = err instanceof Error ? err.message : 'unknown error';
      results.push({
        ...scenario,
        classification: 'error',
        recommended_action: 'draft_for_review',
        confidence: 0,
        draft_reply: null,
        rules_used: [],
        reasoning: `AI run failed: ${msg}`,
      });
      continue;
    }

    results.push({
      ...scenario,
      classification: parsed.classification,
      recommended_action: parsed.recommended_action,
      confidence: parsed.confidence,
      draft_reply: parsed.draft_reply,
      rules_used: parsed.rules_used,
      reasoning: parsed.reasoning,
    });
  }

  // Stamp the campaign so the builder Test step + launch checklist know a run happened.
  await db
    .update(campaigns)
    .set({ lastTestedAt: new Date(), updatedAt: new Date() })
    .where(eq(campaigns.id, input.campaignId));

  return { ran: results.length, results };
}
