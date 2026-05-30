import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as setup from '../services/campaign-setup.service';
import * as aiTasks from '../services/ai-tasks.service';

const PathSchema = z.object({ workspaceId: z.string().uuid(), campaignId: z.string().uuid() });

const GoalSchema = z.object({
  primaryGoal: z.string().min(1),
  secondaryGoal: z.string().optional(),
  primaryCta: z.string().min(1),
  successDefinition: z.string().optional(),
  qualifiedReplyDefinition: z.string().optional(),
  targetAudience: z.string().optional(),
  offerSummary: z.string().optional(),
  allowedClaims: z.string().optional(),
  prohibitedClaims: z.string().optional(),
  handoffTriggers: z.string().optional(),
  autoReplyBoundaries: z.string().optional(),
});

const ExitRulesSchema = z.object({
  maxEmailAttempts: z.number().int().min(0).max(50).optional(),
  maxDaysInSequence: z.number().int().min(0).max(365).optional(),
  maxNoReplyFollowups: z.number().int().min(0).max(50).optional(),
  stopOnUnsubscribe: z.boolean().optional(),
  stopOnHardBounce: z.boolean().optional(),
  stopOnNotInterested: z.boolean().optional(),
  stopOnWrongPersonWithoutReferral: z.boolean().optional(),
  stopOnBadFit: z.boolean().optional(),
  pauseOnOutOfOffice: z.boolean().optional(),
  outOfOfficeResumeDays: z.number().int().min(0).max(365).optional(),
  stopIfNoReplyAfterBreakup: z.boolean().optional(),
  reactivationAllowed: z.boolean().optional(),
  reactivationAfterDays: z.number().int().min(0).max(3650).optional(),
});

// Operator-typed revision instructions. 20K matches the training-chat cap so
// the operator can paste lengthy correction notes (e.g. a whole rewrite of
// the buyer-persona section) without hitting validation.
const ReviseSchema = z.object({
  instructions: z.string().min(1).max(20000),
});

const PlaybookSchema = z.object({
  campaignThesis: z.string().optional(),
  buyerPersona: z.string().optional(),
  targetPains: z.string().optional(),
  valueProposition: z.string().optional(),
  primaryHook: z.string().optional(),
  primaryCta: z.string().optional(),
  objectionMap: z.unknown().optional(),
  allowedClaims: z.string().optional(),
  prohibitedClaims: z.string().optional(),
  handoffRules: z.string().optional(),
  exitRules: z.string().optional(),
  aiOperatingInstructions: z.string().optional(),
});

const DemoGuideSchema = z.object({
  demoGoal: z.string().optional(),
  preCallConfirmationTemplate: z.string().optional(),
  callAgenda: z.string().optional(),
  discoveryQuestions: z.unknown().optional(),
  demoFlow: z.unknown().optional(),
  qualificationQuestions: z.unknown().optional(),
  postCallFollowupTemplate: z.string().optional(),
  proposalRequestChecklist: z.unknown().optional(),
  handoffSummaryTemplate: z.string().optional(),
});

function parseBody<T extends z.ZodTypeAny>(s: T, body: unknown): z.infer<T> {
  const r = s.safeParse(body);
  if (!r.success) {
    throw new ValidationError(
      'Validation failed',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

function parseParams(params: unknown): { workspaceId: string; campaignId: string } {
  const r = PathSchema.safeParse(params);
  if (!r.success) {
    throw new ValidationError(
      'Invalid path',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

const READ = [requireAuth, requireWorkspaceMembership];
const WRITE = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

export async function registerCampaignSetupRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId/campaigns/:campaignId';

  // ---- goal ----
  app.get(`${base}/goal`, { preHandler: READ }, async (req) => {
    const { campaignId } = parseParams(req.params);
    return ok({ goal: await setup.getGoal(req.workspace!.id, campaignId) });
  });
  app.patch(`${base}/goal`, { preHandler: WRITE }, async (req) => {
    const { campaignId } = parseParams(req.params);
    const input = parseBody(GoalSchema.partial(), req.body);
    return ok({ goal: await setup.upsertGoal(req.workspace!.id, campaignId, input) }, 'Updated');
  });
  // Ask Claude (Haiku) for a draft suggestion for one goal field. The user
  // edits the result in the textarea before saving — no DB write here.
  app.post(`${base}/goal/suggest`, { preHandler: WRITE }, async (req) => {
    const { campaignId } = parseParams(req.params);
    const input = parseBody(
      z.object({ field: z.enum(setup.SUGGESTABLE_GOAL_FIELDS) }),
      req.body,
    );
    const r = await setup.suggestGoalField({
      workspaceId: req.workspace!.id,
      campaignId,
      field: input.field,
    });
    return ok(r);
  });

  // ---- exit rules ----
  app.get(`${base}/exit-rules`, { preHandler: READ }, async (req) => {
    const { campaignId } = parseParams(req.params);
    return ok({ exitRules: await setup.getExitRules(req.workspace!.id, campaignId) });
  });
  app.patch(`${base}/exit-rules`, { preHandler: WRITE }, async (req) => {
    const { campaignId } = parseParams(req.params);
    const input = parseBody(ExitRulesSchema, req.body);
    return ok({ exitRules: await setup.upsertExitRules(req.workspace!.id, campaignId, input) }, 'Updated');
  });

  // ---- playbook ----
  app.get(`${base}/playbook`, { preHandler: READ }, async (req) => {
    const { campaignId } = parseParams(req.params);
    return ok({ playbook: await setup.getPlaybook(req.workspace!.id, campaignId) });
  });
  app.patch(`${base}/playbook`, { preHandler: WRITE }, async (req) => {
    const { campaignId } = parseParams(req.params);
    const input = parseBody(PlaybookSchema, req.body);
    return ok({ playbook: await setup.upsertPlaybook(req.workspace!.id, campaignId, input) }, 'Updated');
  });
  app.post(`${base}/playbook/generate`, { preHandler: WRITE }, async (req) => {
    const { campaignId } = parseParams(req.params);
    const result = await aiTasks.generatePlaybook({
      workspaceId: req.workspace!.id,
      campaignId,
    });
    // Persist the generated content as the campaign's playbook (status=draft)
    const persisted = await setup.upsertPlaybook(req.workspace!.id, campaignId, {
      campaignThesis: result.output.campaign_thesis,
      buyerPersona: result.output.buyer_persona,
      targetPains: result.output.target_pains,
      valueProposition: result.output.value_proposition,
      primaryHook: result.output.primary_hook,
      primaryCta: result.output.primary_cta,
      objectionMap: result.output.objection_map,
      allowedClaims: result.output.allowed_claims,
      prohibitedClaims: result.output.prohibited_claims,
      handoffRules: result.output.handoff_rules,
      exitRules: result.output.exit_rules,
      aiOperatingInstructions: result.output.ai_operating_instructions,
    });
    return ok({ playbook: persisted, ai: { actionId: result.action.id, confidence: result.confidence } }, 'Playbook generated');
  });
  app.post(`${base}/playbook/approve`, { preHandler: WRITE }, async (req) => {
    const { campaignId } = parseParams(req.params);
    return ok({ playbook: await setup.approvePlaybook(req.workspace!.id, campaignId) }, 'Playbook approved');
  });

  // Operator-directed revision. Takes free-text instructions ("make the
  // buyer persona more specific to 3PLs", "soften the CTA"), passes them
  // and the CURRENT playbook to the AI, and persists the revised version.
  // Approving a revised playbook is the same /approve call below.
  app.post(`${base}/playbook/revise`, { preHandler: WRITE }, async (req) => {
    const { campaignId } = parseParams(req.params);
    const input = parseBody(ReviseSchema, req.body);
    const current = await setup.getPlaybook(req.workspace!.id, campaignId);
    if (!current) {
      throw new ValidationError('Generate a playbook before revising it', [
        { field: 'playbook', reason: 'no playbook exists yet' },
      ]);
    }
    const result = await aiTasks.revisePlaybook({
      workspaceId: req.workspace!.id,
      campaignId,
      // The AI sees the current playbook in human-readable shape — pass the
      // full DB row so it has all the operator-edited overrides too.
      currentPlaybook: current as unknown as Record<string, unknown>,
      instructions: input.instructions,
    });
    const persisted = await setup.upsertPlaybook(req.workspace!.id, campaignId, {
      campaignThesis: result.output.campaign_thesis,
      buyerPersona: result.output.buyer_persona,
      targetPains: result.output.target_pains,
      valueProposition: result.output.value_proposition,
      primaryHook: result.output.primary_hook,
      primaryCta: result.output.primary_cta,
      objectionMap: result.output.objection_map,
      allowedClaims: result.output.allowed_claims,
      prohibitedClaims: result.output.prohibited_claims,
      handoffRules: result.output.handoff_rules,
      exitRules: result.output.exit_rules,
      aiOperatingInstructions: result.output.ai_operating_instructions,
    });
    return ok(
      { playbook: persisted, ai: { actionId: result.action.id, confidence: result.confidence } },
      'Playbook revised',
    );
  });

  // ---- demo guide ----
  app.get(`${base}/demo-guide`, { preHandler: READ }, async (req) => {
    const { campaignId } = parseParams(req.params);
    return ok({ demoGuide: await setup.getDemoGuide(req.workspace!.id, campaignId) });
  });
  app.patch(`${base}/demo-guide`, { preHandler: WRITE }, async (req) => {
    const { campaignId } = parseParams(req.params);
    const input = parseBody(DemoGuideSchema, req.body);
    return ok({ demoGuide: await setup.upsertDemoGuide(req.workspace!.id, campaignId, input) }, 'Updated');
  });
  app.post(`${base}/demo-guide/generate`, { preHandler: WRITE }, async (req) => {
    const { campaignId } = parseParams(req.params);
    const result = await aiTasks.generateDemoGuide({
      workspaceId: req.workspace!.id,
      campaignId,
    });
    const persisted = await setup.upsertDemoGuide(req.workspace!.id, campaignId, {
      demoGoal: result.output.demo_goal,
      preCallConfirmationTemplate: result.output.pre_call_confirmation_template,
      callAgenda: result.output.call_agenda,
      discoveryQuestions: result.output.discovery_questions,
      demoFlow: result.output.demo_flow,
      qualificationQuestions: result.output.qualification_questions,
      postCallFollowupTemplate: result.output.post_call_followup_template,
      proposalRequestChecklist: result.output.proposal_request_checklist,
      handoffSummaryTemplate: result.output.handoff_summary_template,
    });
    return ok({ demoGuide: persisted, ai: { actionId: result.action.id, confidence: result.confidence } }, 'Demo guide generated');
  });
  app.post(`${base}/demo-guide/revise`, { preHandler: WRITE }, async (req) => {
    const { campaignId } = parseParams(req.params);
    const input = parseBody(ReviseSchema, req.body);
    const current = await setup.getDemoGuide(req.workspace!.id, campaignId);
    if (!current) {
      throw new ValidationError('Generate a demo guide before revising it', [
        { field: 'demoGuide', reason: 'no demo guide exists yet' },
      ]);
    }
    const result = await aiTasks.reviseDemoGuide({
      workspaceId: req.workspace!.id,
      campaignId,
      currentDemoGuide: current as unknown as Record<string, unknown>,
      instructions: input.instructions,
    });
    const persisted = await setup.upsertDemoGuide(req.workspace!.id, campaignId, {
      demoGoal: result.output.demo_goal,
      preCallConfirmationTemplate: result.output.pre_call_confirmation_template,
      callAgenda: result.output.call_agenda,
      discoveryQuestions: result.output.discovery_questions,
      demoFlow: result.output.demo_flow,
      qualificationQuestions: result.output.qualification_questions,
      postCallFollowupTemplate: result.output.post_call_followup_template,
      proposalRequestChecklist: result.output.proposal_request_checklist,
      handoffSummaryTemplate: result.output.handoff_summary_template,
    });
    return ok(
      { demoGuide: persisted, ai: { actionId: result.action.id, confidence: result.confidence } },
      'Demo guide revised',
    );
  });

  app.post(`${base}/demo-guide/approve`, { preHandler: WRITE }, async (req) => {
    const { campaignId } = parseParams(req.params);
    return ok({ demoGuide: await setup.approveDemoGuide(req.workspace!.id, campaignId) }, 'Demo guide approved');
  });
}
