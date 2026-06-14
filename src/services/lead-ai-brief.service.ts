import { and, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../config/db';
import { aiActions, type AiActionType } from '../db/schema/ai-actions';
import {
  leadAiBriefs,
  type LeadAiBrief,
  type LeadAiBriefSequenceState,
  type LeadAiClarifyingQuestion,
  type LeadAiProductSuggestion,
} from '../db/schema/lead-ai-briefs';
import { leads, type Lead } from '../db/schema/leads';
import { salesTrainingProfiles } from '../db/schema/sales-training';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { runAction } from './ai.service';
import { sendEmail, listAccounts } from './gmail.service';
import * as notesService from './sales-note.service';
import * as threadService from './thread.service';

const NOTE_LIMIT = 5;
const NOTE_MAX_CHARS = 700;
const SUMMARY_MAX_CHARS = 4500;

const QuestionOutput = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1).max(220),
        priority: z.enum(['low', 'medium', 'high']).optional(),
      }),
    )
    .min(1)
    .max(5),
  confidence: z.number().min(0).max(1).optional(),
});

const DraftOutput = z.object({
  subject: z.string().min(1).max(140),
  body: z.string().min(1).max(1800),
  reason: z.string().max(500).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const ProductSuggestionOutput = z.object({
  suggestions: z
    .array(
      z.object({
        profileId: z.string().uuid(),
        reason: z.string().min(1).max(300),
      }),
    )
    .max(3),
  confidence: z.number().min(0).max(1).optional(),
});

type DraftOutput = z.infer<typeof DraftOutput>;

export interface BriefPatch {
  primaryProductProfileId?: string | null;
  relatedProductProfileIds?: string[];
  objective?: string | null;
  operatorContext?: string | null;
  constraints?: string | null;
  nextStep?: string | null;
  clarifyingQuestions?: LeadAiClarifyingQuestion[];
}

export async function getOrCreate(
  workspaceId: string,
  leadId: string,
  createdBy?: string | null,
): Promise<LeadAiBrief> {
  const db = getDb();
  await getLead(workspaceId, leadId);
  const existing = await getBrief(workspaceId, leadId);
  if (existing) return existing;
  const [created] = await db
    .insert(leadAiBriefs)
    .values({ workspaceId, leadId, createdBy: createdBy ?? null })
    .returning();
  if (!created) throw new Error('lead AI brief insert returned no row');
  return created;
}

export async function getBrief(workspaceId: string, leadId: string): Promise<LeadAiBrief | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(leadAiBriefs)
    .where(and(eq(leadAiBriefs.workspaceId, workspaceId), eq(leadAiBriefs.leadId, leadId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function patchBrief(
  workspaceId: string,
  leadId: string,
  patch: BriefPatch,
  userId?: string | null,
): Promise<LeadAiBrief> {
  const db = getDb();
  const existing = await getOrCreate(workspaceId, leadId, userId);
  await validateProfiles(workspaceId, [
    patch.primaryProductProfileId ?? undefined,
    ...(patch.relatedProductProfileIds ?? []),
  ]);
  const values: Partial<typeof leadAiBriefs.$inferInsert> = {
    ...(patch.primaryProductProfileId !== undefined ? { primaryProductProfileId: patch.primaryProductProfileId } : {}),
    ...(patch.relatedProductProfileIds !== undefined
      ? { relatedProductProfileIds: Array.from(new Set(patch.relatedProductProfileIds)).slice(0, 6) }
      : {}),
    ...(patch.objective !== undefined ? { objective: textOrNull(patch.objective, 1500) } : {}),
    ...(patch.operatorContext !== undefined ? { operatorContext: textOrNull(patch.operatorContext, 4000) } : {}),
    ...(patch.constraints !== undefined ? { constraints: textOrNull(patch.constraints, 2000) } : {}),
    ...(patch.nextStep !== undefined ? { nextStep: textOrNull(patch.nextStep, 1200) } : {}),
    ...(patch.clarifyingQuestions !== undefined ? { clarifyingQuestions: patch.clarifyingQuestions.slice(0, 5) } : {}),
    updatedAt: new Date(),
  };
  const [updated] = await db
    .update(leadAiBriefs)
    .set(values)
    .where(eq(leadAiBriefs.id, existing.id))
    .returning();
  return updated!;
}

export async function generateQuestions(workspaceId: string, leadId: string): Promise<LeadAiBrief> {
  const db = getDb();
  const brief = await getOrCreate(workspaceId, leadId);
  const { stable, volatile, lead } = await buildBriefAiContext(workspaceId, leadId, brief);
  const result = await runAction({
    workspaceId,
    campaignId: lead.campaignId,
    leadId,
    actionType: 'lead_brief_questions',
    outputSchema: QuestionOutput,
    jsonSchema: {
      type: 'object',
      required: ['questions'],
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: {
            type: 'object',
            required: ['question'],
            properties: {
              question: { type: 'string' },
              priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
          },
        },
        confidence: { type: 'number' },
      },
    },
    taskPrompt:
      'Create 3 to 5 concise clarifying questions the operator can answer to improve this lead-specific follow-up plan. Do not ask questions that are already answered by notes, product training, or the thread. Keep each question specific to this lead.',
    contextExtras: { stable, volatile },
    costMetadata: costMeta(brief, 'operator', 'lead_brief_questions'),
  });
  const questions: LeadAiClarifyingQuestion[] = result.output.questions.map((q, index) => ({
    id: `${Date.now()}-${index}`,
    question: q.question,
    priority: q.priority ?? 'medium',
    answer: null,
  }));
  const [updated] = await db
    .update(leadAiBriefs)
    .set({ clarifyingQuestions: questions, lastGeneratedAt: new Date(), updatedAt: new Date() })
    .where(eq(leadAiBriefs.id, brief.id))
    .returning();
  return updated!;
}

export async function generateProductSuggestions(workspaceId: string, leadId: string): Promise<LeadAiBrief> {
  const db = getDb();
  const brief = await getOrCreate(workspaceId, leadId);
  const { stable, volatile, lead, availableProfiles } = await buildBriefAiContext(workspaceId, leadId, brief);
  const result = await runAction({
    workspaceId,
    campaignId: lead.campaignId,
    leadId,
    actionType: 'lead_product_suggestions',
    outputSchema: ProductSuggestionOutput,
    jsonSchema: {
      type: 'object',
      required: ['suggestions'],
      properties: {
        suggestions: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            required: ['profileId', 'reason'],
            properties: {
              profileId: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
        confidence: { type: 'number' },
      },
    },
    taskPrompt:
      'Suggest up to 3 additional product profiles this lead may be interested in. Only choose profileId values from available_product_profiles. If none are justified, return an empty array. Do not modify products; these are approval suggestions only.',
    contextExtras: { stable, volatile: { ...volatile, available_product_profiles: availableProfiles } },
    costMetadata: costMeta(brief, 'operator', 'lead_product_suggestions'),
  });
  const validIds = new Set(availableProfiles.map((p) => p.id));
  const suggestions: LeadAiProductSuggestion[] = result.output.suggestions
    .filter((s) => validIds.has(s.profileId))
    .map((s) => ({
      id: `${Date.now()}-${s.profileId}`,
      profileId: s.profileId,
      reason: s.reason,
      status: 'pending',
    }));
  const [updated] = await db
    .update(leadAiBriefs)
    .set({ productSuggestions: suggestions, lastGeneratedAt: new Date(), updatedAt: new Date() })
    .where(eq(leadAiBriefs.id, brief.id))
    .returning();
  return updated!;
}

export async function updateProductSuggestion(
  workspaceId: string,
  leadId: string,
  suggestionId: string,
  status: 'approved' | 'dismissed',
): Promise<LeadAiBrief> {
  const brief = await getOrCreate(workspaceId, leadId);
  const target = (brief.productSuggestions ?? []).find((s) => s.id === suggestionId);
  if (!target) throw new NotFoundError('Product suggestion not found');
  const suggestions = (brief.productSuggestions ?? []).map((s) =>
    s.id === suggestionId ? { ...s, status } : s,
  );
  const related =
    status === 'approved'
      ? Array.from(new Set([...(brief.relatedProductProfileIds ?? []), target.profileId])).slice(0, 6)
      : brief.relatedProductProfileIds ?? [];
  await validateProfiles(workspaceId, related);
  const db = getDb();
  const [updated] = await db
    .update(leadAiBriefs)
    .set({ productSuggestions: suggestions, relatedProductProfileIds: related, updatedAt: new Date() })
    .where(eq(leadAiBriefs.id, brief.id))
    .returning();
  return updated!;
}

export async function generateFirstDraft(workspaceId: string, leadId: string): Promise<{ brief: LeadAiBrief; draft: DraftOutput; actionId: string }> {
  const db = getDb();
  const brief = await getOrCreate(workspaceId, leadId);
  const { stable, volatile, lead, threadId } = await buildBriefAiContext(workspaceId, leadId, brief);
  ensureActivationLeadState(lead, brief, false);
  const result = await runAction({
    workspaceId,
    campaignId: lead.campaignId,
    leadId,
    threadId,
    actionType: 'lead_brief_draft',
    outputSchema: DraftOutput,
    jsonSchema: draftJsonSchema(),
    taskPrompt:
      'Draft the first lead-specific follow-up email from the operator. Use the AI brief and manual notes as priority context, but product training and prohibited claims are authoritative. Keep it natural, specific, and under 90 words. Do not include a sign-off if the workspace footer is configured. Return subject and body only plus a short reason.',
    contextExtras: { stable, volatile },
    costMetadata: costMeta(brief, 'operator', 'lead_brief_draft'),
  });
  const [updated] = await db
    .update(leadAiBriefs)
    .set({
      firstDraftActionId: result.action.id,
      sequenceState: 'draft',
      lastGeneratedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(leadAiBriefs.id, brief.id))
    .returning();
  return { brief: updated!, draft: result.output, actionId: result.action.id };
}

export async function approveStart(workspaceId: string, leadId: string): Promise<LeadAiBrief> {
  const db = getDb();
  const brief = await getOrCreate(workspaceId, leadId);
  const lead = await getLead(workspaceId, leadId);
  ensureActivationLeadState(lead, brief, true);
  if (brief.approvedAt) return brief;
  if (!brief.firstDraftActionId) {
    throw new ConflictError('Draft the first message before approving automation.', [
      { field: 'firstDraftActionId', reason: 'missing' },
    ]);
  }
  const draft = await getDraftAction(workspaceId, brief.firstDraftActionId);
  await sendDraftEmail(lead, draft);
  const next = new Date(Date.now() + 2 * 86_400_000);
  const [updated] = await db
    .update(leadAiBriefs)
    .set({ approvedAt: new Date(), sequenceState: 'followup_1', updatedAt: new Date() })
    .where(eq(leadAiBriefs.id, brief.id))
    .returning();
  await db
    .update(leads)
    .set({
      firstContactedAt: lead.firstContactedAt ?? new Date(),
      lastContactedAt: new Date(),
      emailAttemptCount: lead.emailAttemptCount + 1,
      nextActionAt: next,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, lead.id));
  return updated!;
}

export async function runDueBriefFollowups(opts: { workspaceId?: string; limit?: number } = {}): Promise<{ scanned: number; sent: number; blocked: number; errors: number }> {
  const db = getDb();
  const conds = [
    eq(leads.status, 'interested'),
    eq(leads.lifecycleStatus, 'active'),
    eq(leads.aiOwner, true),
    isNotNull(leads.nextActionAt),
    lte(leads.nextActionAt, new Date()),
    sql`${leads.deletedAt} IS NULL`,
    sql`${leads.emailSendFailedAt} IS NULL`,
    isNotNull(leadAiBriefs.approvedAt),
    inArray(leadAiBriefs.sequenceState, ['followup_1', 'followup_2', 'followup_3']),
  ];
  if (opts.workspaceId) conds.push(eq(leads.workspaceId, opts.workspaceId));
  const rows = await db
    .select({ lead: leads, brief: leadAiBriefs })
    .from(leadAiBriefs)
    .innerJoin(leads, eq(leadAiBriefs.leadId, leads.id))
    .where(and(...conds))
    .orderBy(leads.nextActionAt)
    .limit(Math.min(opts.limit ?? 25, 100));

  const stats = { scanned: rows.length, sent: 0, blocked: 0, errors: 0 };
  for (const row of rows) {
    try {
      const sent = await runOneBriefFollowup(row.lead, row.brief);
      if (sent) stats.sent++;
      else stats.blocked++;
    } catch {
      stats.errors++;
    }
  }
  return stats;
}

async function runOneBriefFollowup(lead: Lead, brief: LeadAiBrief): Promise<boolean> {
  const db = getDb();
  if (lead.status !== 'interested' || !lead.aiOwner || lead.lifecycleStatus !== 'active') return false;
  const { stable, volatile, threadId } = await buildBriefAiContext(lead.workspaceId, lead.id, brief);
  const result = await runAction({
    workspaceId: lead.workspaceId,
    campaignId: lead.campaignId,
    leadId: lead.id,
    threadId,
    actionType: 'lead_brief_followup',
    outputSchema: DraftOutput,
    jsonSchema: draftJsonSchema(),
    taskPrompt:
      `Draft the next follow-up for this interested lead. Current lead AI brief sequence state is ${brief.sequenceState}. Keep it natural, useful, and under 90 words. Use prior thread context, but do not repeat the last message. Product training remains authoritative. Return subject and body only plus a short reason.`,
    contextExtras: { stable, volatile },
    costMetadata: costMeta(brief, 'worker', 'lead_brief_followup'),
  });
  await sendDraftEmail(lead, result.output);

  const nextState = nextBriefState(brief.sequenceState);
  const nextActionAt = nextState === 'complete' ? null : new Date(Date.now() + daysForState(nextState) * 86_400_000);
  await db
    .update(leadAiBriefs)
    .set({ sequenceState: nextState, lastGeneratedAt: new Date(), updatedAt: new Date() })
    .where(eq(leadAiBriefs.id, brief.id));
  await db
    .update(leads)
    .set({
      lastContactedAt: new Date(),
      emailAttemptCount: lead.emailAttemptCount + 1,
      followupCount: lead.followupCount + 1,
      noReplyCount: lead.noReplyCount + 1,
      nextActionAt,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, lead.id));
  return true;
}

async function buildBriefAiContext(workspaceId: string, leadId: string, brief: LeadAiBrief) {
  const [lead, primary, related, manualNotes, threads, availableProfiles] = await Promise.all([
    getLead(workspaceId, leadId),
    brief.primaryProductProfileId ? getProfileForBrief(workspaceId, brief.primaryProductProfileId, true) : Promise.resolve(null),
    getProfilesForBrief(workspaceId, brief.relatedProductProfileIds ?? [], false),
    notesService.listForLead(workspaceId, leadId, { kind: 'manual', limit: NOTE_LIMIT }),
    threadService.listByLead(workspaceId, leadId),
    listAvailableProfiles(workspaceId),
  ]);
  const latestThread = threads[0] ?? null;
  const stable = {
    credit_policy: {
      default_model: 'light',
      heavy_model_only_for: ['legal', 'pricing_risk', 'security_risk', 'multi_product_conflict', 'manual_deep_reasoning'],
      output_budget: 'short_email_under_90_words',
    },
    primary_product: primary,
    related_products: related,
  };
  const volatile = {
    brief: briefShape(brief),
    priority_manual_notes: manualNotes.map((n) => ({
      title: n.title,
      body: truncate(n.body, NOTE_MAX_CHARS),
      createdAt: n.createdAt.toISOString(),
    })),
  };
  return { stable, volatile, lead, threadId: latestThread?.id ?? null, availableProfiles };
}

async function getLead(workspaceId: string, leadId: string): Promise<Lead> {
  const db = getDb();
  const rows = await db
    .select()
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError('Lead not found');
  return rows[0];
}

async function getProfileForBrief(workspaceId: string, profileId: string, full: boolean) {
  const db = getDb();
  const rows = await db
    .select()
    .from(salesTrainingProfiles)
    .where(and(eq(salesTrainingProfiles.workspaceId, workspaceId), eq(salesTrainingProfiles.id, profileId)))
    .limit(1);
  const profile = rows[0];
  if (!profile || profile.disabled || profile.status !== 'trained') return null;
  return {
    id: profile.id,
    slug: profile.slug,
    name: profile.name,
    description: profile.description,
    trainedSummary: full ? truncate(profile.trainedSummary ?? '', SUMMARY_MAX_CHARS) : truncate(profile.trainedSummary ?? '', 700),
    behavior: full ? profile.behavior ?? {} : undefined,
  };
}

async function getProfilesForBrief(workspaceId: string, profileIds: string[], full: boolean) {
  const out = [];
  for (const id of Array.from(new Set(profileIds)).slice(0, 6)) {
    const profile = await getProfileForBrief(workspaceId, id, full);
    if (profile) out.push(profile);
  }
  return out;
}

async function listAvailableProfiles(workspaceId: string) {
  const db = getDb();
  return db
    .select({
      id: salesTrainingProfiles.id,
      slug: salesTrainingProfiles.slug,
      name: salesTrainingProfiles.name,
      description: salesTrainingProfiles.description,
    })
    .from(salesTrainingProfiles)
    .where(
      and(
        eq(salesTrainingProfiles.workspaceId, workspaceId),
        eq(salesTrainingProfiles.status, 'trained'),
        eq(salesTrainingProfiles.disabled, false),
      ),
    )
    .orderBy(salesTrainingProfiles.name);
}

async function validateProfiles(workspaceId: string, ids: Array<string | null | undefined>): Promise<void> {
  const wanted = Array.from(new Set(ids.filter(Boolean) as string[]));
  if (wanted.length === 0) return;
  const available = await listAvailableProfiles(workspaceId);
  const valid = new Set(available.map((p) => p.id));
  const missing = wanted.find((id) => !valid.has(id));
  if (missing) {
    throw new ValidationError('Product profile is not available for AI use', [
      { field: 'productProfileId', reason: missing },
    ]);
  }
}

function ensureActivationLeadState(lead: Lead, brief: LeadAiBrief, requireDraft: boolean): void {
  if (lead.status !== 'interested') {
    throw new ConflictError('Lead AI automation requires Interested status.', [
      { field: 'status', reason: 'must_be_interested' },
    ]);
  }
  if (!lead.aiOwner) {
    throw new ConflictError('Turn AI on for this lead before using the AI brief.', [
      { field: 'aiOwner', reason: 'must_be_enabled' },
    ]);
  }
  if (lead.lifecycleStatus !== 'active') {
    throw new ConflictError('Lead must be active before AI follow-up can start.', [
      { field: 'lifecycleStatus', reason: 'must_be_active' },
    ]);
  }
  if (!brief.primaryProductProfileId) {
    throw new ConflictError('Select a primary trained product before drafting.', [
      { field: 'primaryProductProfileId', reason: 'required' },
    ]);
  }
  if (requireDraft && !brief.firstDraftActionId) {
    throw new ConflictError('Draft the first message before approval.', [
      { field: 'firstDraftActionId', reason: 'required' },
    ]);
  }
}

async function getDraftAction(workspaceId: string, actionId: string): Promise<DraftOutput> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(aiActions)
    .where(and(eq(aiActions.workspaceId, workspaceId), eq(aiActions.id, actionId)))
    .limit(1);
  const parsed = DraftOutput.safeParse(row?.aiOutput);
  if (!row || row.status !== 'completed' || !parsed.success) {
    throw new ConflictError('The saved draft is missing or invalid. Generate it again.', [
      { field: 'firstDraftActionId', reason: 'invalid_draft' },
    ]);
  }
  return parsed.data;
}

async function sendDraftEmail(lead: Lead, draft: DraftOutput): Promise<void> {
  const threads = await threadService.listByLead(lead.workspaceId, lead.id);
  const existing = threads[0] ?? null;
  let gmailAccountId = existing?.gmailAccountId ?? null;
  if (!gmailAccountId) {
    const accounts = await listAccounts(lead.workspaceId);
    const usable = accounts.find((a) => a.isActive && a.healthStatus !== 'paused');
    if (!usable) {
      throw new ConflictError('No active Gmail account on this workspace.', [
        { field: 'gmail', reason: 'no_active_account' },
      ]);
    }
    gmailAccountId = usable.id;
  }
  await sendEmail({
    workspaceId: lead.workspaceId,
    gmailAccountId,
    to: lead.email,
    subject: draft.subject,
    body: draft.body,
    threadId: existing?.gmailThreadId ?? undefined,
    campaignId: lead.campaignId ?? undefined,
    leadId: lead.id,
  });
}

function briefShape(brief: LeadAiBrief) {
  return {
    id: brief.id,
    objective: brief.objective,
    operatorContext: brief.operatorContext,
    constraints: brief.constraints,
    nextStep: brief.nextStep,
    clarifyingQuestions: brief.clarifyingQuestions ?? [],
    sequenceState: brief.sequenceState,
    approvedAt: brief.approvedAt?.toISOString() ?? null,
  };
}

function costMeta(brief: LeadAiBrief, trigger: 'operator' | 'worker', actionType: AiActionType) {
  return {
    feature: 'lead_ai_brief',
    briefId: brief.id,
    sequenceState: brief.sequenceState,
    primaryProductProfileId: brief.primaryProductProfileId,
    relatedProductProfileIds: brief.relatedProductProfileIds ?? [],
    trigger,
    actionType,
  };
}

function draftJsonSchema() {
  return {
    type: 'object',
    required: ['subject', 'body'],
    properties: {
      subject: { type: 'string' },
      body: { type: 'string' },
      reason: { type: 'string' },
      confidence: { type: 'number' },
    },
  };
}

function nextBriefState(state: LeadAiBriefSequenceState): LeadAiBriefSequenceState {
  if (state === 'followup_1') return 'followup_2';
  if (state === 'followup_2') return 'followup_3';
  return 'complete';
}

function daysForState(state: LeadAiBriefSequenceState): number {
  if (state === 'followup_2') return 3;
  if (state === 'followup_3') return 4;
  return 0;
}

function textOrNull(value: string | null | undefined, max: number): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed ? truncate(trimmed, max) : null;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
