import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { UnauthorizedError, ValidationError } from '../utils/errors';
import * as training from '../services/training.service';
import * as aiTasks from '../services/ai-tasks.service';
import * as setup from '../services/campaign-setup.service';

const SessionPath = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  sessionId: z.string().uuid(),
});
const CampaignPath = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
});

const MessageSchema = z.object({
  message: z.string().min(1).max(20000),
  // When true, persist the user message but DO NOT call the AI. Used by the
  // frontend to ship long pastes as multiple silent chunks, then a final
  // non-silent turn that triggers the AI reply with the full context in view.
  silent: z.boolean().optional(),
});

function parseBody<T extends z.ZodTypeAny>(s: T, b: unknown): z.infer<T> {
  const r = s.safeParse(b);
  if (!r.success) {
    throw new ValidationError(
      'Validation failed',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}
function parsePath<T extends z.ZodTypeAny>(s: T, p: unknown): z.infer<T> {
  const r = s.safeParse(p);
  if (!r.success) {
    throw new ValidationError(
      'Invalid path',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

const WRITE = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

export async function registerCampaignTrainingRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId/campaigns/:campaignId/training';

  app.post(`${base}/start`, { preHandler: WRITE }, async (req, reply) => {
    if (!req.user) throw new UnauthorizedError();
    const { campaignId } = parsePath(CampaignPath, req.params);
    const session = await training.startSession({
      workspaceId: req.workspace!.id,
      campaignId,
      startedByUserId: req.user.id,
    });
    reply.code(201);
    return ok({ session }, 'Training session started');
  });

  app.get(`${base}/:sessionId`, { preHandler: WRITE }, async (req) => {
    const { campaignId, sessionId } = parsePath(SessionPath, req.params);
    return ok({ session: await training.getSession(req.workspace!.id, campaignId, sessionId) });
  });

  app.post(`${base}/:sessionId/message`, { preHandler: WRITE }, async (req) => {
    const { campaignId, sessionId } = parsePath(SessionPath, req.params);
    const input = parseBody(MessageSchema, req.body);
    const r = await training.sendUserMessage({
      workspaceId: req.workspace!.id,
      campaignId,
      sessionId,
      userMessage: input.message,
      silent: input.silent ?? false,
    });
    return ok(r);
  });

  app.post(`${base}/:sessionId/generate-playbook`, { preHandler: WRITE }, async (req) => {
    const { campaignId, sessionId } = parsePath(SessionPath, req.params);
    const session = await training.getSession(req.workspace!.id, campaignId, sessionId);
    const transcript = training.transcript(session);
    const result = await aiTasks.generatePlaybook({
      workspaceId: req.workspace!.id,
      campaignId,
      trainingTranscript: transcript,
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
    return ok({ playbook: persisted, ai: { actionId: result.action.id, confidence: result.confidence } });
  });

  app.post(`${base}/:sessionId/generate-demo-guide`, { preHandler: WRITE }, async (req) => {
    const { campaignId, sessionId } = parsePath(SessionPath, req.params);
    const session = await training.getSession(req.workspace!.id, campaignId, sessionId);
    const transcript = training.transcript(session);
    const result = await aiTasks.generateDemoGuide({
      workspaceId: req.workspace!.id,
      campaignId,
      trainingTranscript: transcript,
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
    return ok({ demoGuide: persisted, ai: { actionId: result.action.id, confidence: result.confidence } });
  });

  app.post(`${base}/:sessionId/approve`, { preHandler: WRITE }, async (req) => {
    const { campaignId, sessionId } = parsePath(SessionPath, req.params);
    return ok(
      { session: await training.approveSession(req.workspace!.id, campaignId, sessionId) },
      'Training session approved',
    );
  });
}
