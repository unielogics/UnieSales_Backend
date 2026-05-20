import { eq, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getAnthropic } from '../config/anthropic';
import { getDb } from '../config/db';
import { aiActions, type AiAction, type AiActionType, type NewAiAction } from '../db/schema/ai-actions';
import { AppError } from '../utils/errors';
import { buildContext, type AiContextPackage, type AiContextRequest } from './ai-context.service';
import { modelFor } from './ai-router.service';

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

    // 3. Call Claude with cache-friendly system + json_schema output
    const model = modelFor(input.actionType, input.forceHeavy);
    const userPrompt = formatUserPrompt(context, input.taskPrompt);

    const anthropic = getAnthropic();
    // Plain JSON-in-prompt approach. Older SDK versions don't type cache_control
    // or output_config on messages.create — instruct Claude to return JSON and
    // parse it ourselves. The schema is included in the prompt so the model has
    // the shape; we still validate with zod after parsing.
    const response = await anthropic.messages.create({
      model,
      max_tokens: input.forceHeavy ? MAX_TOKENS_HEAVY : MAX_TOKENS_LIGHT,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            userPrompt +
            `\n\n## Required output shape\n\nReturn a single JSON object matching this schema. Output ONLY the JSON, no prose, no markdown fence:\n\n` +
            JSON.stringify(input.jsonSchema, null, 2),
        },
      ],
    });

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

function formatUserPrompt(context: AiContextPackage, taskPrompt: string): string {
  return `## Context

${JSON.stringify(context, null, 2)}

## Task

${taskPrompt}`;
}

// ---- AI queue helpers (for routes + workers) ----

export async function listQueue(workspaceId: string, opts: { status?: string; limit?: number }): Promise<AiAction[]> {
  const db = getDb();
  const conds = [eq(aiActions.workspaceId, workspaceId)];
  if (opts.status) conds.push(eq(aiActions.status, opts.status));
  return db
    .select()
    .from(aiActions)
    .where(and(...conds))
    .orderBy(sql`${aiActions.createdAt} DESC`)
    .limit(Math.min(opts.limit ?? 100, 500));
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

export async function approveAction(workspaceId: string, actionId: string): Promise<AiAction> {
  const db = getDb();
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
