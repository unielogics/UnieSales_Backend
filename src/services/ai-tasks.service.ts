/**
 * Concrete AI task wrappers. Each function builds a task-specific prompt
 * and JSON schema, runs it through ai.service.runAction, and returns the
 * validated output plus the persisted ai_actions row.
 */
import { z } from 'zod';
import { runAction, type AiActionResult } from './ai.service';

// ---------- score_lead ----------

const ScoreLeadOutputSchema = z.object({
  score: z.number().int().min(0).max(100),
  reasoning: z.string().min(1),
  fit: z.enum(['high', 'medium', 'low']),
  confidence: z.number().min(0).max(1),
});
export type ScoreLeadOutput = z.infer<typeof ScoreLeadOutputSchema>;

export async function scoreLead(input: {
  workspaceId: string;
  campaignId: string;
  leadId: string;
}): Promise<AiActionResult<ScoreLeadOutput>> {
  return runAction({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    leadId: input.leadId,
    actionType: 'score_lead',
    outputSchema: ScoreLeadOutputSchema,
    taskPrompt:
      'Score this lead 0–100 based on fit with the campaign target_audience, primary_goal, and playbook buyer_persona. Use the lead\'s company, title, segment, website, AND source + source_notes — the operator often writes hand-curated notes there (e.g. "met at X conference", "interested in Y", "referred by Z") that should heavily inform the score and reasoning. If source_notes contains explicit buying signals, score accordingly. Provide reasoning and a fit bucket.',
    jsonSchema: {
      type: 'object',
      properties: {
        score: { type: 'integer', minimum: 0, maximum: 100 },
        reasoning: { type: 'string' },
        fit: { type: 'string', enum: ['high', 'medium', 'low'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['score', 'reasoning', 'fit', 'confidence'],
      additionalProperties: false,
    },
  });
}

// ---------- generate_email ----------

const GenerateEmailOutputSchema = z.object({
  subject: z.string().min(1).max(150),
  body: z.string().min(1).max(4000),
  personalization_used: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});
export type GenerateEmailOutput = z.infer<typeof GenerateEmailOutputSchema>;

export async function generateEmail(input: {
  workspaceId: string;
  campaignId: string;
  leadId: string;
  stage?: 'cold' | 'followup_1' | 'followup_2' | 'followup_3' | 'breakup';
}): Promise<AiActionResult<GenerateEmailOutput>> {
  const stage = input.stage ?? 'cold';
  return runAction({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    leadId: input.leadId,
    actionType: 'generate_email',
    outputSchema: GenerateEmailOutputSchema,
    taskPrompt: `Draft a ${stage} outbound email for this lead. Use playbook.primary_hook and primary_cta. Reference one specific detail about the lead — prefer source_notes if it contains useful context (e.g. how they were sourced, what they expressed interest in, who referred them), otherwise fall back to company/title/website. If source_notes mentions a specific topic or pain, weave that in naturally. Keep it under 120 words. No invented claims, pricing, or guarantees.`,
    jsonSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        body: { type: 'string' },
        personalization_used: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reasoning: { type: 'string' },
      },
      required: ['subject', 'body', 'personalization_used', 'confidence', 'reasoning'],
      additionalProperties: false,
    },
  });
}

// ---------- classify_reply ----------

const REPLY_CLASSIFICATIONS = [
  'positive_interest',
  'meeting_request',
  'send_more_info',
  'pricing_question',
  'objection_existing_system',
  'objection_not_now',
  'objection_cost',
  'objection_skeptical',
  'referral',
  'wrong_person',
  'out_of_office',
  'unsubscribe',
  'not_interested',
  'bounce',
  'angry_or_sensitive',
  'unknown_needs_review',
  'continue_nurture',
  'pause_out_of_office',
  'close_not_interested',
  'close_bad_fit',
  'close_wrong_person',
  'close_unsubscribed',
  'close_bounced',
  'handoff_required',
  'call_scheduled',
  'reactivation_candidate',
] as const;

const ClassifyReplyOutputSchema = z.object({
  classification: z.enum(REPLY_CLASSIFICATIONS),
  confidence: z.number().min(0).max(1),
  lead_temperature: z.enum(['hot', 'warm', 'cold', 'frozen']),
  should_auto_reply: z.boolean(),
  should_create_draft: z.boolean(),
  should_handoff: z.boolean(),
  should_stop_sequence: z.boolean(),
  should_pause: z.boolean(),
  close_reason: z.string().nullable(),
  summary: z.string(),
  detected_pain_points: z.array(z.string()),
  recommended_next_action: z.string(),
  reply_subject: z.string().nullable(),
  reply_body: z.string().nullable(),
  handoff_summary: z.string().nullable(),
});
export type ClassifyReplyOutput = z.infer<typeof ClassifyReplyOutputSchema>;

export async function classifyReply(input: {
  workspaceId: string;
  campaignId: string;
  leadId: string;
  threadId: string;
  forceHeavy?: boolean;
}): Promise<AiActionResult<ClassifyReplyOutput>> {
  return runAction({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    leadId: input.leadId,
    threadId: input.threadId,
    actionType: 'classify_reply',
    outputSchema: ClassifyReplyOutputSchema,
    forceHeavy: input.forceHeavy,
    taskPrompt: `Read the most recent inbound message in the thread and classify it. Return one of the allowed classifications and the recommended next action.

Auto-send is allowed only when ALL of the following are true:
- workspace.auto_reply_enabled = true
- confidence >= workspace.auto_reply_confidence_threshold
- classification is safe (not pricing/legal/contracts/revenue share/loan terms/custom implementation)
- not angry or sensitive
- not a high-value lead requiring handoff
- exit rules allow sending

Always hand off (should_handoff=true, should_auto_reply=false) for: pricing, contracts, legal, revenue share, loan terms, active funding scenario, demo request needing a real human, custom implementation, enterprise opportunity, angry replies, ambiguous high-value cases.

When you choose a draft (should_create_draft=true), populate reply_subject and reply_body.`,
    jsonSchema: {
      type: 'object',
      properties: {
        classification: { type: 'string', enum: REPLY_CLASSIFICATIONS as unknown as string[] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        lead_temperature: { type: 'string', enum: ['hot', 'warm', 'cold', 'frozen'] },
        should_auto_reply: { type: 'boolean' },
        should_create_draft: { type: 'boolean' },
        should_handoff: { type: 'boolean' },
        should_stop_sequence: { type: 'boolean' },
        should_pause: { type: 'boolean' },
        close_reason: { type: ['string', 'null'] },
        summary: { type: 'string' },
        detected_pain_points: { type: 'array', items: { type: 'string' } },
        recommended_next_action: { type: 'string' },
        reply_subject: { type: ['string', 'null'] },
        reply_body: { type: ['string', 'null'] },
        handoff_summary: { type: ['string', 'null'] },
      },
      required: [
        'classification',
        'confidence',
        'lead_temperature',
        'should_auto_reply',
        'should_create_draft',
        'should_handoff',
        'should_stop_sequence',
        'should_pause',
        'close_reason',
        'summary',
        'detected_pain_points',
        'recommended_next_action',
        'reply_subject',
        'reply_body',
        'handoff_summary',
      ],
      additionalProperties: false,
    },
  });
}

// ---------- summarize_thread ----------

const SummarizeThreadOutputSchema = z.object({
  summary: z.string(),
  key_points: z.array(z.string()),
  current_state: z.string(),
  recommended_next_action: z.string(),
  confidence: z.number().min(0).max(1),
});
export type SummarizeThreadOutput = z.infer<typeof SummarizeThreadOutputSchema>;

export async function summarizeThread(input: {
  workspaceId: string;
  campaignId?: string;
  leadId?: string;
  threadId: string;
}): Promise<AiActionResult<SummarizeThreadOutput>> {
  return runAction({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId ?? null,
    leadId: input.leadId ?? null,
    threadId: input.threadId,
    actionType: 'summarize_thread',
    outputSchema: SummarizeThreadOutputSchema,
    taskPrompt:
      'Summarize this email thread. Return a 2-3 sentence summary, 3-6 key points, the current state of the conversation (e.g. "Lead asked for pricing, awaiting response"), and the recommended next action.',
    jsonSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        key_points: { type: 'array', items: { type: 'string' } },
        current_state: { type: 'string' },
        recommended_next_action: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['summary', 'key_points', 'current_state', 'recommended_next_action', 'confidence'],
      additionalProperties: false,
    },
  });
}

// ---------- generate_playbook (heavy) ----------

const GeneratePlaybookOutputSchema = z.object({
  campaign_thesis: z.string(),
  buyer_persona: z.string(),
  target_pains: z.string(),
  value_proposition: z.string(),
  primary_hook: z.string(),
  primary_cta: z.string(),
  objection_map: z.array(
    z.object({ objection: z.string(), response: z.string(), handoff: z.boolean() }),
  ),
  allowed_claims: z.string(),
  prohibited_claims: z.string(),
  handoff_rules: z.string(),
  exit_rules: z.string(),
  ai_operating_instructions: z.string(),
  confidence: z.number().min(0).max(1),
});
export type GeneratePlaybookOutput = z.infer<typeof GeneratePlaybookOutputSchema>;

export async function generatePlaybook(input: {
  workspaceId: string;
  campaignId: string;
  trainingTranscript?: string;
}): Promise<AiActionResult<GeneratePlaybookOutput>> {
  return runAction({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    actionType: 'generate_playbook',
    outputSchema: GeneratePlaybookOutputSchema,
    forceHeavy: true,
    taskPrompt: `Synthesize a campaign playbook the AI Sales Operator will follow during outbound + nurture.

Use the campaign context (goal, target audience, knowledge files) AND the training transcript below if provided. Never invent pricing, guarantees, legal terms, revenue shares, or unsupported claims — pull everything from what the user actually said in training and what's in the knowledge files.

${input.trainingTranscript ? `\n## Training transcript\n\n${input.trainingTranscript}\n` : ''}`,
    jsonSchema: {
      type: 'object',
      properties: {
        campaign_thesis: { type: 'string' },
        buyer_persona: { type: 'string' },
        target_pains: { type: 'string' },
        value_proposition: { type: 'string' },
        primary_hook: { type: 'string' },
        primary_cta: { type: 'string' },
        objection_map: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              objection: { type: 'string' },
              response: { type: 'string' },
              handoff: { type: 'boolean' },
            },
            required: ['objection', 'response', 'handoff'],
            additionalProperties: false,
          },
        },
        allowed_claims: { type: 'string' },
        prohibited_claims: { type: 'string' },
        handoff_rules: { type: 'string' },
        exit_rules: { type: 'string' },
        ai_operating_instructions: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: [
        'campaign_thesis',
        'buyer_persona',
        'target_pains',
        'value_proposition',
        'primary_hook',
        'primary_cta',
        'objection_map',
        'allowed_claims',
        'prohibited_claims',
        'handoff_rules',
        'exit_rules',
        'ai_operating_instructions',
        'confidence',
      ],
      additionalProperties: false,
    },
  });
}

// ---------- generate_demo_guide (heavy) ----------

const GenerateDemoGuideOutputSchema = z.object({
  demo_goal: z.string(),
  pre_call_confirmation_template: z.string(),
  call_agenda: z.string(),
  discovery_questions: z.array(z.string()),
  demo_flow: z.array(z.string()),
  qualification_questions: z.array(z.string()),
  post_call_followup_template: z.string(),
  proposal_request_checklist: z.array(z.string()),
  handoff_summary_template: z.string(),
  confidence: z.number().min(0).max(1),
});
export type GenerateDemoGuideOutput = z.infer<typeof GenerateDemoGuideOutputSchema>;

export async function generateDemoGuide(input: {
  workspaceId: string;
  campaignId: string;
  trainingTranscript?: string;
}): Promise<AiActionResult<GenerateDemoGuideOutput>> {
  return runAction({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    actionType: 'generate_demo_guide',
    outputSchema: GenerateDemoGuideOutputSchema,
    forceHeavy: true,
    taskPrompt: `Produce a demo / discovery call playbook for this campaign. Pull from the campaign goal, playbook (if it exists), and the training transcript if provided. Keep templates editable and concise.

${input.trainingTranscript ? `\n## Training transcript\n\n${input.trainingTranscript}\n` : ''}`,
    jsonSchema: {
      type: 'object',
      properties: {
        demo_goal: { type: 'string' },
        pre_call_confirmation_template: { type: 'string' },
        call_agenda: { type: 'string' },
        discovery_questions: { type: 'array', items: { type: 'string' } },
        demo_flow: { type: 'array', items: { type: 'string' } },
        qualification_questions: { type: 'array', items: { type: 'string' } },
        post_call_followup_template: { type: 'string' },
        proposal_request_checklist: { type: 'array', items: { type: 'string' } },
        handoff_summary_template: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: [
        'demo_goal',
        'pre_call_confirmation_template',
        'call_agenda',
        'discovery_questions',
        'demo_flow',
        'qualification_questions',
        'post_call_followup_template',
        'proposal_request_checklist',
        'handoff_summary_template',
        'confidence',
      ],
      additionalProperties: false,
    },
  });
}

// ---------- summarize_knowledge ----------

const SummarizeKnowledgeOutputSchema = z.object({
  summary: z.string(),
  document_type: z.enum([
    'product_overview',
    'faq',
    'pricing',
    'pitch_deck',
    'objection_library',
    'compliance',
    'case_study',
    'demo_notes',
    'uploaded_notes',
    'other',
  ]),
  key_facts: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type SummarizeKnowledgeOutput = z.infer<typeof SummarizeKnowledgeOutputSchema>;

export async function summarizeKnowledge(input: {
  workspaceId: string;
  campaignId: string;
  fileName: string;
  extractedText: string;
}): Promise<AiActionResult<SummarizeKnowledgeOutput>> {
  return runAction({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    actionType: 'summarize_knowledge',
    outputSchema: SummarizeKnowledgeOutputSchema,
    taskPrompt: `Summarize this campaign knowledge file. Identify the document_type from the allowed list, write a 2-4 sentence summary, and extract 5-12 key facts that the AI could reference in outbound emails or reply handling.

File name: ${input.fileName}

Extracted text (truncated to first 8000 chars):
${input.extractedText.slice(0, 8000)}`,
    jsonSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        document_type: {
          type: 'string',
          enum: [
            'product_overview',
            'faq',
            'pricing',
            'pitch_deck',
            'objection_library',
            'compliance',
            'case_study',
            'demo_notes',
            'uploaded_notes',
            'other',
          ],
        },
        key_facts: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['summary', 'document_type', 'key_facts', 'confidence'],
      additionalProperties: false,
    },
  });
}
