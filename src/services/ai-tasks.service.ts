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
      'Score this lead 0–100 based on fit with the campaign target_audience, primary_goal, and playbook buyer_persona. Use the lead\'s company, title, segment, website, AND source + source_notes — the operator often writes hand-curated notes there (e.g. "met at X conference", "interested in Y", "referred by Z") that should heavily inform the score and reasoning. ALSO inspect lead.custom_fields — these are operator-defined columns from the CSV/Sheet import (per-campaign, schema-less; example keys: fleet_size, wms_in_use, revenue_range, fit_signal). Treat any value there as high-signal qualification data and weight it heavily when present. If source_notes or custom_fields contain explicit buying signals, score accordingly. Provide reasoning and a fit bucket.',
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

// ---------- classify_lead (lightweight triage) ----------

const ClassifyLeadOutputSchema = z.object({
  temperature: z.enum(['hot', 'warm', 'cold', 'frozen']),
  intent_labels: z.array(z.string()).max(8),
  summary: z.string().min(1).max(800),
  confidence: z.number().min(0).max(1),
});
export type ClassifyLeadOutput = z.infer<typeof ClassifyLeadOutputSchema>;

/**
 * Triage classification for an inbound lead. Reads the same ai-context
 * package as score_lead but produces a different shape: a temperature
 * bucket the runtime uses to pick the next action, plus intent labels
 * (e.g. "warehouse_audit", "wants_pricing", "exploring", "wrong_person")
 * that surface in the Intelligence tab and feed the AI Behavior rules.
 */
export async function classifyLead(input: {
  workspaceId: string;
  campaignId: string;
  leadId: string;
}): Promise<AiActionResult<ClassifyLeadOutput>> {
  return runAction({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    leadId: input.leadId,
    actionType: 'classify_lead',
    outputSchema: ClassifyLeadOutputSchema,
    taskPrompt:
      'Classify this lead for triage. Inputs: lead.company_name, contact_name, title, segment, source, source_notes, custom_fields (which on inbound rows contains the full form payload at .fields and a flat key→value map at .flat — pay particular attention to fields like monthlyVolume, integrationTimeline, auditType, currentWms, providerType, persona, partner_type, mode, audit_type). Output: (1) temperature — "hot" for explicit buying signals or urgent timeline, "warm" for qualified persona + relevant pain, "cold" for low/no signal but still on-ICP, "frozen" for clear bad-fit / wrong-person / hobbyist / abusive. (2) intent_labels — 2–6 short snake_case labels (e.g. "wants_demo", "wants_pricing", "exploring", "audit_request", "partner_inquiry", "qualified_persona", "low_volume", "wrong_person"). (3) summary — 2–3 sentences for the Intelligence tab: who they are, why they showed up, the strongest signal you saw. (4) confidence — your certainty in the classification.',
    jsonSchema: {
      type: 'object',
      properties: {
        temperature: { type: 'string', enum: ['hot', 'warm', 'cold', 'frozen'] },
        intent_labels: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        summary: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['temperature', 'intent_labels', 'summary', 'confidence'],
      additionalProperties: false,
    },
  });
}

// ---------- generate_email ----------

const GenerateEmailOutputSchema = z.object({
  subject: z.string().min(1).max(150),
  body: z.string().min(1).max(4000),
  personalization_used: z.array(z.string()),
  attachment_file_ids: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});
export type GenerateEmailOutput = z.infer<typeof GenerateEmailOutputSchema>;

export async function generateEmail(input: {
  workspaceId: string;
  campaignId: string;
  leadId: string;
  stage?: 'cold' | 'followup_1' | 'followup_2' | 'followup_3' | 'breakup';
  /** Outbound channel. SMS forces short copy, no subject, no footer, no attachments. */
  channel?: 'email' | 'sms';
}): Promise<AiActionResult<GenerateEmailOutput>> {
  const stage = input.stage ?? 'cold';
  const channel = input.channel ?? 'email';
  const smsBlock = channel === 'sms'
    ? `\n\nSMS MODE (override the above):\n- This is an SMS, not an email. body MUST be a single short message — under 300 characters, ideally under 160. No subject line, no greeting block, no signature, no footer, no quoted lines, no attachments. Return an empty array for attachment_file_ids. Conversational, one ask. Subject is ignored downstream; return any short tag.`
    : '';
  return runAction({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    leadId: input.leadId,
    actionType: 'generate_email',
    outputSchema: GenerateEmailOutputSchema,
    taskPrompt: `Draft a ${stage} outbound email for this lead, written in the FIRST PERSON as the human sender. It must read like a real person typed it — never like a company or a bot. Never describe the company in the third person, and never sign off with the company name.

VOICE — match the operator's own writing style:
- Follow workspace.email_style_guide if it is present.
- Study workspace.email_samples (real emails the operator wrote) and mimic their voice, sentence rhythm, warmth, and structure — these samples define the target style.
- Plain, human, conversational; short sentences; no corporate or marketing jargon, no buzzwords, no hype.

GREETING:
- Prefer lead.first_name when present (e.g. "Hi Sarah,"). Otherwise use the first token of lead.contact_name. Never use the email local-part as a name.

CONTENT:
- Use playbook.primary_hook and primary_cta.
- Reference one specific detail about the lead — prefer source_notes (how they were sourced, what they care about, who referred them) or any value in lead.custom_fields (operator-defined CSV columns like fleet_size, wms_in_use, revenue_range, AND inbound-form fields like monthlyVolume, integrationTimeline, auditType, currentWms, providerType, persona, partner_type — these are CAMPAIGN-SPECIFIC qualification data and often the strongest hook); otherwise fall back to company/title/website. When you reference a custom_fields value, weave it in like a human who looked them up would ("you're running ~200 trucks across 3 yards") — never quote raw keys or dump JSON.
- Keep it under 120 words. No invented claims, pricing, or guarantees.

SIGN-OFF:
- If workspace.has_footer is true: do NOT write any closing signature, name, title, or company line — a footer is appended automatically. End on your final sentence.
- If workspace.has_footer is false: end with a brief first-person sign-off using only the sender's first name (from workspace.default_sender_name).

ATTACHMENTS:
- context.attachments lists marketing files (PDFs, app one-pagers, decks) you MAY attach. Each has an id, title, document_type, and summary.
- Attach a file ONLY when it genuinely helps THIS email and stage — e.g. introducing the mobile app on a cold email. Don't attach on every follow-up; don't attach if nothing fits.
- Put the chosen file id(s) in attachment_file_ids (empty array if none). When you attach something, reference it naturally in the body in one short line (e.g. "I've attached a quick overview of the app"). If attachment_file_ids is empty, never mention an attachment.${smsBlock}`,
    jsonSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        body: { type: 'string' },
        personalization_used: { type: 'array', items: { type: 'string' } },
        attachment_file_ids: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reasoning: { type: 'string' },
      },
      required: ['subject', 'body', 'personalization_used', 'attachment_file_ids', 'confidence', 'reasoning'],
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
  proposed_time: z.string().nullable(),
  attachment_file_ids: z.array(z.string()),
  /** 'email' / 'sms' if the lead asked to be contacted on the other channel; null otherwise. */
  prefer_channel: z.enum(['email', 'sms']).nullable(),
});
export type ClassifyReplyOutput = z.infer<typeof ClassifyReplyOutputSchema>;

export async function classifyReply(input: {
  workspaceId: string;
  campaignId: string;
  leadId: string;
  threadId: string;
  forceHeavy?: boolean;
  /** Anchors relative-date parsing for scheduling. */
  schedulingHint?: { nowIso: string; timezone: string };
  /** Conversation channel — SMS replies must be short and signature-free. */
  channel?: 'email' | 'sms';
}): Promise<AiActionResult<ClassifyReplyOutput>> {
  const schedulingBlock = input.schedulingHint
    ? `\n- Current time is ${input.schedulingHint.nowIso}. The operator schedules in timezone ${input.schedulingHint.timezone} — resolve relative dates ("tomorrow", "next Tuesday", "3pm") against that.`
    : '';
  const smsBlock = input.channel === 'sms'
    ? `\n\nSMS REPLY MODE:\n- The conversation is over SMS. reply_subject MUST be null. reply_body MUST be a single short message under 300 characters (ideally under 160) — no greeting block, no signature, no quoted lines, no attachments. attachment_file_ids MUST be an empty array.`
    : '';
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

When you choose a draft (should_create_draft=true), populate reply_subject and reply_body. Write reply_body in the FIRST PERSON as the human sender — it must sound like a real person, matching workspace.email_style_guide and the voice of workspace.email_samples. If workspace.has_footer is true, do not add any signature or sign-off; otherwise close with the sender's first name only.

SCHEDULING:
- If the lead asks to meet / talk / hop on a call but has NOT committed to a specific time, classify as meeting_request and set proposed_time to null. Keep reply_body short and warm — do NOT invent or propose specific times yourself; the system appends real open calendar slots automatically.
- If the lead picked or proposed a specific date and time (including choosing one of the options we offered), classify as call_scheduled and return proposed_time as an ISO 8601 datetime WITH a timezone offset (e.g. "2026-05-27T14:00:00-04:00"). reply_body should warmly confirm.
- proposed_time must be null for every other classification.${schedulingBlock}

ATTACHMENTS:
- context.attachments lists marketing files (PDFs, app one-pagers, decks) you MAY attach to a reply. Each has an id, title, document_type, summary.
- When drafting a reply, attach a file ONLY when it directly answers what the lead asked — e.g. attach the app overview when they ask "what does the app do?". Otherwise attach nothing.
- Put chosen file id(s) in attachment_file_ids (empty array if none). When you attach something, reference it in reply_body in one short line. Never mention an attachment when attachment_file_ids is empty.${smsBlock}

CHANNEL PREFERENCE:
- If the reply explicitly asks to switch contact channel ("email me", "send by email", "send to my email", "can you text me", "by text", "shoot me a text"), set prefer_channel accordingly ('email' or 'sms'). Otherwise null.
- The switch affects FUTURE outreach only — your current auto-reply still goes back on whichever channel they messaged you on.`,
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
        proposed_time: { type: ['string', 'null'] },
        attachment_file_ids: { type: 'array', items: { type: 'string' } },
        prefer_channel: { type: ['string', 'null'], enum: ['email', 'sms', null] },
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
        'proposed_time',
        'attachment_file_ids',
        'prefer_channel',
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

// ---------- revise_playbook (heavy) ----------

/**
 * Apply operator revision instructions to an existing playbook. Same output
 * shape as generate_playbook so the upsert path is shared — the difference is
 * the prompt: instead of synthesizing from scratch, the AI starts from the
 * current playbook and surgically applies the requested changes while
 * preserving everything else.
 */
export async function revisePlaybook(input: {
  workspaceId: string;
  campaignId: string;
  currentPlaybook: Record<string, unknown>;
  instructions: string;
}): Promise<AiActionResult<GeneratePlaybookOutput>> {
  return runAction({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    actionType: 'revise_playbook',
    outputSchema: GeneratePlaybookOutputSchema,
    forceHeavy: true,
    taskPrompt: `Revise the campaign playbook below according to the operator's instructions.

REVISION RULES:
- Apply the instructions surgically. Sections the operator did NOT mention must be returned unchanged (verbatim from the current playbook).
- Preserve voice, tone, and structure. Don't rewrite working language unless the operator asked you to.
- Never invent pricing, guarantees, legal terms, revenue shares, or unsupported claims. If the instructions ask for something unsupported, push back in confidence/reasoning and leave that section unchanged.
- Return the FULL playbook in the output schema — every field, including the unchanged ones. The frontend replaces the whole playbook on save.

## Operator instructions

${input.instructions}

## Current playbook

\`\`\`json
${JSON.stringify(input.currentPlaybook, null, 2)}
\`\`\``,
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

// ---------- revise_demo_guide (heavy) ----------

/**
 * Apply operator revision instructions to an existing demo guide. Same
 * output shape as generate_demo_guide for shared upsert.
 */
export async function reviseDemoGuide(input: {
  workspaceId: string;
  campaignId: string;
  currentDemoGuide: Record<string, unknown>;
  instructions: string;
}): Promise<AiActionResult<GenerateDemoGuideOutput>> {
  return runAction({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    actionType: 'revise_demo_guide',
    outputSchema: GenerateDemoGuideOutputSchema,
    forceHeavy: true,
    taskPrompt: `Revise the demo / discovery call guide below according to the operator's instructions.

REVISION RULES:
- Apply the instructions surgically. Sections the operator did NOT mention must be returned unchanged (verbatim from the current guide).
- Preserve voice, tone, and structure. Don't rewrite working templates unless the operator asked you to.
- Keep templates concise and editable. Never invent pricing, guarantees, or unsupported claims.
- Return the FULL demo guide in the output schema — every field, including the unchanged ones.

## Operator instructions

${input.instructions}

## Current demo guide

\`\`\`json
${JSON.stringify(input.currentDemoGuide, null, 2)}
\`\`\``,
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
