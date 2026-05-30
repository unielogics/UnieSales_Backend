import { eq, and, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getAnthropic } from '../config/anthropic';
import { getDb } from '../config/db';
import { aiActions, type AiAction, type AiActionType, type NewAiAction } from '../db/schema/ai-actions';
import { leads } from '../db/schema/leads';
import { AppError } from '../utils/errors';
import { buildContext, type AiContextPackage, type AiContextRequest } from './ai-context.service';
import { modelFor } from './ai-router.service';
import { sendEmail } from './gmail.service';
import * as threadService from './thread.service';
import { sendSmsToLead } from './sms.service';

const SYSTEM_PROMPT = `You are the AI Sales Operator for a multi-workspace outbound + nurture platform.

Rules you must follow on every call:
1. Use ONLY information from the context package provided. Do NOT invent pricing, guarantees, revenue shares, loan terms, contracts, or claims that are not in the context.
2. Respect prohibited_claims, exit_rules, and handoff_triggers. If a topic falls under any of these, set should_handoff or should_stop_sequence appropriately and explain in reason.
3. All responses MUST be valid JSON matching the schema you are given. No prose outside the JSON.
4. Be concise, professional, and tailored to the lead.
5. If you are uncertain, return lower confidence and recommend human review.`;

const MAX_TOKENS_LIGHT = 2048;
const MAX_TOKENS_HEAVY = 8192;

interface RunActionInput<T> {
  workspaceId: string;
  actionType: AiActionType;
  campaignId?: string | null;
  leadId?: string | null;
  threadId?: string | null;
  /** Schema the model must output. */
  outputSchema: z.ZodType<T>;
  /** Per-task instructions. The context package is injected automatically. */
  taskPrompt: string;
  /** JSON schema sent to Anthropic for structured output. */
  jsonSchema: Record<string, unknown>;
  forceHeavy?: boolean;
}

export interface AiActionResult<T> {
  action: AiAction;
  output: T;
  confidence: number | null;
}

/**
 * Run a single AI action end-to-end: insert ai_actions row, build context,
 * call Claude with json_schema output, validate, persist result.
 */
export async function runAction<T>(input: RunActionInput<T>): Promise<AiActionResult<T>> {
  const db = getDb();

  // 1. Insert ai_actions row (pending → processing)
  const [pending] = await db
    .insert(aiActions)
    .values({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId ?? null,
      leadId: input.leadId ?? null,
      emailThreadId: input.threadId ?? null,
      actionType: input.actionType,
      status: 'processing',
    } as NewAiAction)
    .returning();
  if (!pending) throw new Error('failed to create ai_actions row');

  try {
    // 2. Build context
    const ctxReq: AiContextRequest = {
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      leadId: input.leadId,
      threadId: input.threadId,
    };
    const context = await buildContext(ctxReq);

    // 3. Call Claude. We split the prompt so the STABLE prefix is cacheable and
    //    only the volatile per-lead data is billed fresh each call:
    //      system block 1 — global operator rules (constant)
    //      system block 2 — per-task instructions + required output schema (constant per task)
    //      system block 3 — campaign/product context (workspace, playbook, product_training
    //                       digest, rules) — stable across all leads in a campaign — with a
    //                       cache_control breakpoint so it (and everything before it) is cached.
    //      user message    — the volatile lead + thread JSON.
    //    Within the 5-min cache TTL, a batch of leads in the same campaign (or the
    //    score→classify pair on one lead) reuses the cached prefix at ~10% input cost.
    const model = modelFor(input.actionType, input.forceHeavy);
    const anthropic = getAnthropic();
    const { stable, volatile } = splitContext(context);

    const response = await anthropic.messages.create({
      model,
      max_tokens: input.forceHeavy ? MAX_TOKENS_HEAVY : MAX_TOKENS_LIGHT,
      system: [
        { type: 'text', text: SYSTEM_PROMPT },
        {
          type: 'text',
          text:
            `## Task\n\n${input.taskPrompt}\n\n` +
            `## Required output shape\n\nReturn a single JSON object matching this schema. Output ONLY the JSON, no prose, no markdown fence:\n\n` +
            JSON.stringify(input.jsonSchema),
        },
        {
          type: 'text',
          text: `## Campaign & product context\n\n${JSON.stringify(stable)}`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `## Lead & conversation\n\n${JSON.stringify(volatile)}`,
        },
      ],
    });
    const usage = response.usage;

    // 4. Extract text payload — Anthropic always returns a Message here (not a Stream)
    //    because we didn't set stream: true.
    const message = response as { content: Array<{ type: string; text?: string }> };
    const rawText = message.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    if (!rawText) throw new AppError('AI returned empty response', 502);

    // Strip accidental markdown fences if Claude added them
    const cleaned = rawText
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(cleaned);
    } catch (err) {
      throw new AppError(`AI returned invalid JSON: ${(err as Error).message}`, 502);
    }

    // 5. Validate against zod schema
    const validation = input.outputSchema.safeParse(parsedJson);
    if (!validation.success) {
      throw new AppError(
        'AI output failed schema validation',
        502,
        validation.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
      );
    }
    const output = validation.data;
    const confidence = extractConfidence(parsedJson);

    // 6. Persist result
    const [updated] = await db
      .update(aiActions)
      .set({
        status: 'completed',
        aiOutput: parsedJson as Record<string, unknown>,
        confidence: confidence != null ? confidence.toFixed(3) : null,
        // Token accounting (prompt-cache aware) for cost dashboards.
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        cacheReadTokens: usage?.cache_read_input_tokens ?? null,
        cacheCreationTokens: usage?.cache_creation_input_tokens ?? null,
        completedAt: new Date(),
      })
      .where(eq(aiActions.id, pending.id))
      .returning();

    return { action: updated!, output, confidence };
  } catch (err) {
    await db
      .update(aiActions)
      .set({
        status: 'failed',
        reason: err instanceof Error ? err.message.slice(0, 2000) : String(err).slice(0, 2000),
        completedAt: new Date(),
      })
      .where(eq(aiActions.id, pending.id));
    throw err;
  }
}

function extractConfidence(json: unknown): number | null {
  if (typeof json !== 'object' || json === null) return null;
  const obj = json as Record<string, unknown>;
  const c = obj.confidence;
  if (typeof c === 'number' && c >= 0 && c <= 1) return c;
  return null;
}

/**
 * Split the context into the campaign/product-stable portion (cacheable prefix)
 * and the volatile per-lead portion. lead + thread change every call; everything
 * else (workspace, campaign, playbook, knowledge, attachments, rules,
 * product_training digest) is stable across leads in a campaign.
 */
function splitContext(context: AiContextPackage): {
  stable: Omit<AiContextPackage, 'lead' | 'thread'>;
  volatile: { lead: AiContextPackage['lead']; thread: AiContextPackage['thread'] };
} {
  const { lead, thread, ...stable } = context;
  return { stable, volatile: { lead: lead ?? null, thread: thread ?? null } };
}

// ---- AI queue helpers (for routes + workers) ----

export async function listQueue(
  workspaceId: string,
  opts: { status?: string; limit?: number; origin?: 'intake' | 'outbound' },
): Promise<AiAction[]> {
  const db = getDb();
  const conds = [eq(aiActions.workspaceId, workspaceId)];
  if (opts.status) conds.push(eq(aiActions.status, opts.status));
  // Origin filter: ai_actions don't carry origin directly, so we filter via
  // the linked lead's import_origin. Actions without a lead (system-internal)
  // are treated as outbound (legacy default).
  if (opts.origin === 'intake') {
    const intakeLeads = db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.workspaceId, workspaceId), eq(leads.importOrigin, 'intake')));
    conds.push(inArray(aiActions.leadId, intakeLeads));
  } else if (opts.origin === 'outbound') {
    const outboundLeads = db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.workspaceId, workspaceId),
          or(isNull(leads.importOrigin), ne(leads.importOrigin, 'intake'))!,
        ),
      );
    // Actions with no lead OR whose lead is non-intake — both belong to outbound.
    conds.push(or(isNull(aiActions.leadId), inArray(aiActions.leadId, outboundLeads))!);
  }
  return db
    .select()
    .from(aiActions)
    .where(and(...conds))
    .orderBy(sql`${aiActions.createdAt} DESC`)
    .limit(Math.min(opts.limit ?? 100, 500));
}

// ---- Planned AI work (the "Pending AI" page) ----

/**
 * A single thing the AI is going to do — either a scheduled outbound send
 * (a lead the followup worker will contact) or a queued ai_actions job
 * (a drafted reply / classification awaiting processing or operator review).
 */
export interface PlannedAction {
  id: string;
  kind: 'scheduled_send' | 'queued_action';
  actionType: string;
  actionLabel: string;
  leadId: string | null;
  campaignId: string | null;
  contactName: string | null;
  companyName: string | null;
  email: string | null;
  summary: string;
  subject: string | null;
  body: string | null;
  confidence: number | null;
  /** When it fires (ISO). Null = awaiting review / processing now. */
  triggerAt: string | null;
  status: string;
  createdAt: string;
}

function stageLabelFromStatus(status: string): string {
  switch (status) {
    case 'sent_email_1':
      return 'Follow-up 1';
    case 'sent_followup_1':
      return 'Follow-up 2';
    case 'sent_followup_2':
      return 'Follow-up 3';
    case 'sent_followup_3':
      return 'Break-up email';
    default:
      return 'Cold email';
  }
}

const QUEUED_ACTION_LABELS: Record<string, string> = {
  create_draft: 'AI draft reply',
  generate_reply: 'AI draft reply',
  classify_reply: 'Classify inbound reply',
  generate_email: 'Generate email',
  score_lead: 'Score lead',
  summarize_thread: 'Summarize thread',
  handoff: 'Escalate to human',
};

/** Everything the AI has planned for this workspace — for the Pending AI page. */
export async function listPlanned(
  workspaceId: string,
  opts: { origin?: 'intake' | 'outbound' } = {},
): Promise<PlannedAction[]> {
  const db = getDb();

  // Origin filter for the lead-level query (#1) below.
  const leadOriginCond =
    opts.origin === 'intake'
      ? eq(leads.importOrigin, 'intake')
      : opts.origin === 'outbound'
        ? or(isNull(leads.importOrigin), ne(leads.importOrigin, 'intake'))!
        : undefined;

  // 1. Scheduled sends — leads the followup worker will contact.
  const scheduledConds = [
    eq(leads.workspaceId, workspaceId),
    eq(leads.lifecycleStatus, 'active'),
    eq(leads.aiOwner, true),
    sql`${leads.nextActionAt} IS NOT NULL`,
  ];
  if (leadOriginCond) scheduledConds.push(leadOriginCond);
  const scheduled = await db
    .select()
    .from(leads)
    .where(and(...scheduledConds))
    .orderBy(leads.nextActionAt)
    .limit(500);

  const out: PlannedAction[] = scheduled.map((l): PlannedAction => {
    const label = stageLabelFromStatus(l.status);
    const who = l.companyName || l.contactName || l.email;
    return {
      id: `lead:${l.id}`,
      kind: 'scheduled_send',
      actionType: 'scheduled_send',
      actionLabel: label,
      leadId: l.id,
      campaignId: l.campaignId,
      contactName: l.contactName,
      companyName: l.companyName,
      email: l.email,
      summary: `Send ${label.toLowerCase()} to ${who}`,
      subject: null,
      body: null,
      confidence: null,
      triggerAt: l.nextActionAt ? l.nextActionAt.toISOString() : null,
      status: 'scheduled',
      createdAt: l.updatedAt.toISOString(),
    };
  });

  // 2. Queued AI jobs — drafts / classifications awaiting processing or review.
  const queuedConds = [
    eq(aiActions.workspaceId, workspaceId),
    inArray(aiActions.status, ['pending', 'processing']),
  ];
  // Origin filter on the joined lead. Actions without a lead are treated as
  // outbound (legacy default).
  if (opts.origin === 'intake') {
    queuedConds.push(eq(leads.importOrigin, 'intake'));
  } else if (opts.origin === 'outbound') {
    queuedConds.push(
      or(isNull(leads.id), isNull(leads.importOrigin), ne(leads.importOrigin, 'intake'))!,
    );
  }
  const queued = await db
    .select({
      a: aiActions,
      leadEmail: leads.email,
      leadName: leads.contactName,
      leadCompany: leads.companyName,
    })
    .from(aiActions)
    .leftJoin(leads, eq(aiActions.leadId, leads.id))
    .where(and(...queuedConds))
    .orderBy(sql`${aiActions.createdAt} DESC`)
    .limit(500);

  for (const row of queued) {
    const a = row.a;
    const aiOut = (a.aiOutput ?? {}) as { subject?: string; body?: string };
    const label =
      QUEUED_ACTION_LABELS[a.actionType ?? ''] ??
      (a.actionType ?? 'AI action').replace(/_/g, ' ');
    const who = row.leadCompany || row.leadName || row.leadEmail || '';
    out.push({
      id: `action:${a.id}`,
      kind: 'queued_action',
      actionType: a.actionType ?? 'unknown',
      actionLabel: label,
      leadId: a.leadId,
      campaignId: a.campaignId,
      contactName: row.leadName ?? null,
      companyName: row.leadCompany ?? null,
      email: row.leadEmail ?? null,
      summary: a.reason ?? (who ? `${label} · ${who}` : label),
      subject: aiOut.subject ?? null,
      body: aiOut.body ?? null,
      confidence: a.confidence != null ? Number(a.confidence) : null,
      triggerAt: null,
      status: a.status ?? 'pending',
      createdAt: a.createdAt.toISOString(),
    });
  }

  // Soonest first; queued items (no triggerAt) need attention now → sort to top.
  out.sort((x, y) => {
    const tx = x.triggerAt ? new Date(x.triggerAt).getTime() : 0;
    const ty = y.triggerAt ? new Date(y.triggerAt).getTime() : 0;
    return tx - ty;
  });
  return out;
}

export async function getAction(workspaceId: string, actionId: string): Promise<AiAction | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(aiActions)
    .where(and(eq(aiActions.workspaceId, workspaceId), eq(aiActions.id, actionId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Action types whose aiOutput is a {subject, body} draft email. */
const DRAFT_ACTION_TYPES = new Set<AiActionType>(['create_draft', 'generate_reply']);

/**
 * Approve a queued AI action. For draft-email actions (create_draft /
 * generate_reply) the approval also SENDS the email — threaded onto the
 * original conversation — so the operator clicking "approve" in the Inbox
 * actually puts the reply in the lead's inbox.
 */
export async function approveAction(workspaceId: string, actionId: string): Promise<AiAction> {
  const db = getDb();

  const existing = await getAction(workspaceId, actionId);
  if (!existing) throw new AppError('Action not found', 404);

  // Send the drafted reply if this is a draft-email action with a thread.
  if (
    existing.actionType &&
    DRAFT_ACTION_TYPES.has(existing.actionType as AiActionType) &&
    existing.emailThreadId &&
    existing.status !== 'approved'
  ) {
    const out = (existing.aiOutput ?? {}) as {
      subject?: string;
      body?: string;
      attachmentFileIds?: string[];
    };
    const body = (out.body ?? '').trim();
    if (body) {
      const thread = await threadService.getById(workspaceId, existing.emailThreadId);
      if (thread.channel === 'sms') {
        if (!thread.leadId) throw new AppError('SMS thread has no lead', 409);
        await sendSmsToLead({ workspaceId, leadId: thread.leadId, body });
      } else {
        if (!thread.gmailAccountId) throw new AppError('Thread has no Gmail account', 409);
        const subject = out.subject ?? (thread.subject ? `Re: ${thread.subject}` : 'Re:');
        await sendEmail({
          workspaceId,
          gmailAccountId: thread.gmailAccountId,
          to: thread.lead?.email ?? '',
          subject,
          body,
          threadId: thread.gmailThreadId ?? undefined,
          campaignId: thread.campaignId ?? undefined,
          leadId: thread.leadId ?? undefined,
          bypassHealthGate: true,
          attachmentFileIds: Array.isArray(out.attachmentFileIds) ? out.attachmentFileIds : undefined,
        });
      }
    }
  }

  const rows = await db
    .update(aiActions)
    .set({ status: 'approved', completedAt: new Date() })
    .where(and(eq(aiActions.workspaceId, workspaceId), eq(aiActions.id, actionId)))
    .returning();
  if (!rows[0]) throw new AppError('Action not found', 404);
  return rows[0];
}

export async function rejectAction(workspaceId: string, actionId: string, reason?: string): Promise<AiAction> {
  const db = getDb();
  const rows = await db
    .update(aiActions)
    .set({ status: 'rejected', reason: reason ?? null, completedAt: new Date() })
    .where(and(eq(aiActions.workspaceId, workspaceId), eq(aiActions.id, actionId)))
    .returning();
  if (!rows[0]) throw new AppError('Action not found', 404);
  return rows[0];
}

/**
 * Bulk-reject pending AI actions. Same semantics as rejectAction but for a
 * batch — backs the "Delete N selected" affordance in the AI Queue's
 * "Awaiting review" group. Only flips rows whose status is still 'pending'
 * (others are already terminal). Idempotent.
 */
export async function bulkRejectActions(
  workspaceId: string,
  actionIds: string[],
  reason = 'operator_bulk_cancel',
): Promise<{ rejected: number }> {
  if (actionIds.length === 0) return { rejected: 0 };
  const db = getDb();
  const result = await db
    .update(aiActions)
    .set({ status: 'rejected', reason, completedAt: new Date() })
    .where(
      and(
        eq(aiActions.workspaceId, workspaceId),
        inArray(aiActions.id, actionIds),
        eq(aiActions.status, 'pending'),
      ),
    )
    .returning({ id: aiActions.id });
  return { rejected: result.length };
}
