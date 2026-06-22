/**
 * Post-intake runner — triage-only AI pass that fires after every public
 * intake submission (and in principle, anywhere else we want to baseline a
 * fresh lead). Default behaviour is intentionally cautious:
 *
 *   1. Acquire lock (lead_processing_locks unique on lead_id+process_name).
 *   2. Score the lead with the existing scoreLead AI task; persist to leads.
 *   3. Classify the lead with the new classifyLead AI task.
 *   4. Compose an `intake_summary` note that captures both outputs.
 *   5. Create a `review_ai_draft` task (Draft Only is the default mode).
 *   6. Set leads.pipeline_stage = 'ai_reviewed' unless a dedicated source
 *      stage already exists, and stamp post_intake_processed_at so retries no-op.
 *   7. Mark the lock completed.
 *
 * Auto-send is intentionally NOT here. Per the Layer-2 plan, autonomous
 * outbound is gated on AI Behavior cards being approved, the campaign being
 * switched to `safe_auto`, and confidence thresholds met — none of which is
 * wired in v1. The runner just surfaces information; the operator approves
 * sends from the lead modal.
 *
 * Idempotency strategy:
 *   - leads.post_intake_processed_at non-null → skip immediately.
 *   - lead_processing_locks unique-violation → another runner won the race,
 *     skip without doing work.
 *   - On uncaught failure, mark lock 'failed' so a manual retry tool can
 *     clear it; do NOT update post_intake_processed_at (leaving the lead
 *     eligible to be retried).
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/db';
import { leads } from '../db/schema/leads';
import { leadProcessingLocks } from '../db/schema/lead-processing-locks';
import { scoreLead, classifyLead, type ScoreLeadOutput, type ClassifyLeadOutput } from './ai-tasks.service';
import * as activity from './sales-activity.service';
import * as notes from './sales-note.service';
import * as tasks from './sales-task.service';
import * as notify from './notification.service';
import { salesTrainingProfiles } from '../db/schema/sales-training';

const PROCESS_NAME = 'intake_post_process';

export interface RunInput {
  workspaceId: string;
  leadId: string;
  campaignId: string;
}

export interface RunResult {
  skipped: boolean;
  reason?: 'already_processed' | 'lock_held' | 'no_campaign';
  scoreActionId?: string;
  classifyActionId?: string;
  noteId?: string;
  taskId?: string;
}

/**
 * Public entrypoint. Safe to call multiple times for the same lead — the
 * second call will short-circuit on the idempotency check.
 */
export async function run(input: RunInput): Promise<RunResult> {
  const db = getDb();

  // --- 1. Fast idempotency check -------------------------------------------
  const leadRow = (
    await db
      .select({
        id: leads.id,
        postIntakeProcessedAt: leads.postIntakeProcessedAt,
        campaignId: leads.campaignId,
        pipelineStage: leads.pipelineStage,
        customFields: leads.customFields,
        deletedAt: leads.deletedAt,
      })
      .from(leads)
      .where(and(eq(leads.workspaceId, input.workspaceId), eq(leads.id, input.leadId)))
      .limit(1)
  )[0];
  if (!leadRow) {
    // Lead vanished between intake INSERT and the runner — extremely unlikely.
    return { skipped: true, reason: 'already_processed' };
  }
  if (leadRow.postIntakeProcessedAt != null) {
    return { skipped: true, reason: 'already_processed' };
  }
  if (leadRow.deletedAt != null) {
    // Operator soft-deleted the lead before the runner could fire. Skip —
    // there's no point scoring or drafting for a lead the operator killed.
    return { skipped: true, reason: 'already_processed' };
  }
  if (!leadRow.campaignId) {
    return { skipped: true, reason: 'no_campaign' };
  }

  // Sales Training kill switch lookup. One profile per product (= per site)
  // in the new model, so we match by site alone. If the matching profile is
  // disabled, the runner still triages (score + classify + note) but creates
  // a human_handoff task instead of review_ai_draft so the operator handles
  // the reply by hand.
  let isDisabled = false;
  {
    const cf = (leadRow.customFields ?? {}) as Record<string, unknown>;
    const site = typeof cf.site === 'string' ? cf.site : null;
    if (site) {
      const r = await db
        .select({ disabled: salesTrainingProfiles.disabled })
        .from(salesTrainingProfiles)
        .where(
          and(
            eq(salesTrainingProfiles.workspaceId, input.workspaceId),
            eq(salesTrainingProfiles.sourceSite, site),
          ),
        )
        .limit(1);
      isDisabled = r[0]?.disabled === true;
    }
  }

  // --- 2. Lock --------------------------------------------------------------
  // The unique (lead_id, process_name) index turns a concurrent retry into a
  // 23505. Treat that as "someone else is running this", not as an error.
  let lockId: string | null = null;
  try {
    const [row] = await db
      .insert(leadProcessingLocks)
      .values({
        workspaceId: input.workspaceId,
        leadId: input.leadId,
        processName: PROCESS_NAME,
        status: 'running',
      })
      .returning({ id: leadProcessingLocks.id });
    lockId = row?.id ?? null;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return { skipped: true, reason: 'lock_held' };
    }
    throw err;
  }

  let scoreOut: ScoreLeadOutput | null = null;
  let scoreActionId: string | undefined;
  let classifyOut: ClassifyLeadOutput | null = null;
  let classifyActionId: string | undefined;
  let noteId: string | undefined;
  let taskId: string | undefined;

  try {
    // --- 3. Score ----------------------------------------------------------
    const scoreRes = await scoreLead({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      leadId: input.leadId,
    });
    scoreOut = scoreRes.output;
    scoreActionId = scoreRes.action.id;

    // Persist score on the lead row so the existing UI surfaces it.
    await db
      .update(leads)
      .set({
        leadScore: scoreOut.score,
        leadScoreReason: scoreOut.reasoning,
        updatedAt: new Date(),
      })
      .where(eq(leads.id, input.leadId));

    await activity.emit({
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      campaignId: input.campaignId,
      activityType: 'ai_scored',
      title: `Scored ${scoreOut.score}/100 · ${scoreOut.fit} fit`,
      description: scoreOut.reasoning.slice(0, 240),
      metadata: { score: scoreOut.score, fit: scoreOut.fit, confidence: scoreOut.confidence, ai_action_id: scoreActionId },
      createdBy: 'ai',
    });

    // --- 4. Classify -------------------------------------------------------
    const classifyRes = await classifyLead({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      leadId: input.leadId,
    });
    classifyOut = classifyRes.output;
    classifyActionId = classifyRes.action.id;

    await activity.emit({
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      campaignId: input.campaignId,
      activityType: 'ai_classified',
      title: `${classifyOut.temperature} · ${classifyOut.intent_labels.join(', ')}`,
      description: classifyOut.summary.slice(0, 240),
      metadata: {
        temperature: classifyOut.temperature,
        intent_labels: classifyOut.intent_labels,
        confidence: classifyOut.confidence,
        ai_action_id: classifyActionId,
      },
      createdBy: 'ai',
    });

    // --- 5. Intake summary note --------------------------------------------
    const noteBody = composeIntakeSummary(scoreOut, classifyOut);
    const note = await notes.create({
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      kind: 'intake_summary',
      title: `Intake triage · ${classifyOut.temperature} · ${scoreOut.score}/100`,
      body: noteBody,
      aiActionId: classifyActionId,
    });
    noteId = note.id;

    // --- 6. Task --------------------------------------------------------------
    // Default Draft Only behaviour: a queued task tells the operator there's
    // a triaged lead awaiting their decision. The runner does NOT generate an
    // outbound email here — that's a later phase, gated by AI Behavior.
    //
    // If the matching Sales Training profile is disabled, the operator wants
    // AI to step back: same triage data, but the task type flips to
    // human_handoff so the cockpit treats it as "you reply, not the AI".
    const task = await tasks.create({
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      title: isDisabled
        ? `Handoff (AI disabled for form) · ${classifyOut.temperature} · ${scoreOut.score}/100`
        : `Review inbound lead · ${classifyOut.temperature} · ${scoreOut.score}/100`,
      type: isDisabled ? 'human_handoff' : 'review_ai_draft',
      priority: classifyOut.temperature === 'hot' ? 'high' : classifyOut.temperature === 'warm' ? 'med' : 'low',
      source: 'AI',
    });
    taskId = task.id;

    // --- 6b. Notify the operator (mobile push + Alerts feed) ----------------
    // A disabled-form lead or a hot lead is an urgent handoff; everything else
    // is a draft/review notification. Best-effort — never blocks the runner.
    {
      const isHot = classifyOut.temperature === 'hot';
      const isHandoff = isDisabled || isHot;
      await notify.emit({
        workspaceId: input.workspaceId,
        leadId: input.leadId,
        kind: isHandoff ? 'handoff' : 'draft',
        priority: isHandoff ? 'urgent' : 'high',
        title: isHot
          ? `🔥 Hot lead · ${scoreOut.score}/100 — needs you`
          : isHandoff
            ? `Handoff — ${classifyOut.temperature} inbound lead`
            : `New lead to review · ${scoreOut.score}/100`,
        body: classifyOut.summary ? classifyOut.summary.slice(0, 200) : null,
        meta: classifyOut.intent_labels?.length ? classifyOut.intent_labels.join(', ') : null,
      });
    }

    // --- 7. Pipeline stage + idempotency stamp -----------------------------
    const nextStage = leadRow.pipelineStage === 'new_catalog_audit' ? 'new_catalog_audit' : 'ai_reviewed';
    await db
      .update(leads)
      .set({
        pipelineStage: nextStage,
        postIntakeProcessedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(leads.id, input.leadId));

    await activity.emit({
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      campaignId: input.campaignId,
      activityType: 'stage_changed',
      title: `Stage -> ${nextStage}`,
      metadata: { from: leadRow.pipelineStage ?? 'new_inbound', to: nextStage },
      createdBy: 'ai',
    });

    // --- 8. Mark lock complete --------------------------------------------
    if (lockId) {
      await db
        .update(leadProcessingLocks)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(leadProcessingLocks.id, lockId));
    }

    return { skipped: false, scoreActionId, classifyActionId, noteId, taskId };
  } catch (err) {
    // Best-effort: mark the lock failed so an operator-facing retry tool can
    // find and re-run it. Do NOT stamp post_intake_processed_at — the lead
    // stays eligible.
    if (lockId) {
      try {
        await db
          .update(leadProcessingLocks)
          .set({ status: 'failed', completedAt: new Date() })
          .where(eq(leadProcessingLocks.id, lockId));
      } catch {
        // swallow — original error is what matters
      }
    }
    throw err;
  }
}

function composeIntakeSummary(score: ScoreLeadOutput, classify: ClassifyLeadOutput): string {
  const lines: string[] = [];
  lines.push(`Temperature: ${classify.temperature}`);
  if (classify.intent_labels.length > 0) {
    lines.push(`Intent: ${classify.intent_labels.join(', ')}`);
  }
  lines.push(`Score: ${score.score}/100 (${score.fit} fit)`);
  lines.push('');
  lines.push(classify.summary.trim());
  lines.push('');
  lines.push('— Why this score:');
  lines.push(score.reasoning.trim());
  return lines.join('\n');
}
