import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getAnthropic } from '../config/anthropic';
import { env } from '../config/env';
import { getDb } from '../config/db';
import {
  campaignTrainingSessions,
  type CampaignTrainingSession,
  type NewCampaignTrainingSession,
} from '../db/schema/campaign-training-sessions';
import {
  campaignTrainingMessages,
  type CampaignTrainingMessage,
  type NewCampaignTrainingMessage,
} from '../db/schema/campaign-training-messages';
import { aiActions } from '../db/schema/ai-actions';
import { campaigns } from '../db/schema/campaigns';
import { AppError, ConflictError, NotFoundError } from '../utils/errors';
import { buildContext } from './ai-context.service';

const TRAINING_SYSTEM_PROMPT = `You are the Campaign Training Strategist for the UnieSales Multi-Workspace AI Sales Operator.

Your job is to help the user design a campaign the AI can safely and effectively operate.

Interview the user about:
- buyer (who they sell to, decision-maker profile)
- offer (what they sell, what's unique)
- goal (book demo, generate qualified reply, drive form-fill, etc)
- primary CTA
- workflow to sale (steps from cold reply to closed-won)
- objections (top 3-5 they hear)
- proof (case studies, social proof, numbers they can cite)
- prohibited claims (anything they cannot legally promise)
- handoff points (when the AI must hand off to a human)
- exit logic (when to stop pursuing a lead)
- demo/call flow (what a great discovery call looks like)

Rules:
- Ask one or two focused questions per turn — do not flood the user.
- Challenge weak assumptions. If the offer is too broad, the CTA too aggressive, the audience too mixed, the claims unsupported, or the AI would not know when to stop or hand off, say so clearly and recommend a better structure.
- Never invent pricing, guarantees, legal terms, revenue shares, loan terms, implementation promises, or unsupported claims.
- Move forward — once you have enough on a topic, move on. Don't loop.
- After ~10-15 exchanges (or sooner if the user is concise), tell the user you have what you need and recommend they trigger /generate-playbook and /generate-demo-guide.`;

export interface TrainingSessionWithMessages extends CampaignTrainingSession {
  messages: CampaignTrainingMessage[];
}

// ---- session lifecycle ----

export async function startSession(input: {
  workspaceId: string;
  campaignId: string;
  startedByUserId: string;
}): Promise<TrainingSessionWithMessages> {
  const db = getDb();
  // Ensure the campaign exists in this workspace
  const c = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.workspaceId, input.workspaceId), eq(campaigns.id, input.campaignId)))
    .limit(1);
  if (!c[0]) throw new NotFoundError('Campaign not found');

  const [session] = await db
    .insert(campaignTrainingSessions)
    .values({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      startedByUserId: input.startedByUserId,
      status: 'in_progress',
    } as NewCampaignTrainingSession)
    .returning();

  // Update campaign status to training_in_progress (informational)
  await db
    .update(campaigns)
    .set({ status: 'training_in_progress', updatedAt: new Date() })
    .where(eq(campaigns.id, input.campaignId));

  // Seed an opening assistant message so the UI has something to render
  const openingText =
    "Hi! I'll help you set up this campaign so the AI can run it safely. Let's start at the top: who is the ideal buyer you're trying to reach with this campaign, and what's the offer in one sentence?";
  await db.insert(campaignTrainingMessages).values({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    trainingSessionId: session!.id,
    role: 'assistant',
    message: openingText,
  } as NewCampaignTrainingMessage);

  return getSession(input.workspaceId, input.campaignId, session!.id);
}

export async function getSession(
  workspaceId: string,
  campaignId: string,
  sessionId: string,
): Promise<TrainingSessionWithMessages> {
  const db = getDb();
  const sRows = await db
    .select()
    .from(campaignTrainingSessions)
    .where(
      and(
        eq(campaignTrainingSessions.workspaceId, workspaceId),
        eq(campaignTrainingSessions.campaignId, campaignId),
        eq(campaignTrainingSessions.id, sessionId),
      ),
    )
    .limit(1);
  if (!sRows[0]) throw new NotFoundError('Training session not found');
  const messages = await db
    .select()
    .from(campaignTrainingMessages)
    .where(eq(campaignTrainingMessages.trainingSessionId, sessionId))
    .orderBy(asc(campaignTrainingMessages.createdAt));
  return { ...sRows[0], messages };
}

// ---- chat turn ----

const ChatTurnInput = z.object({
  message: z.string().min(1).max(8000),
});

export async function sendUserMessage(input: {
  workspaceId: string;
  campaignId: string;
  sessionId: string;
  userMessage: string;
}): Promise<{ session: TrainingSessionWithMessages; reply: string }> {
  const db = getDb();
  ChatTurnInput.parse({ message: input.userMessage });

  const session = await getSession(input.workspaceId, input.campaignId, input.sessionId);
  if (session.status === 'completed') {
    throw new ConflictError('Training session already completed');
  }

  // Persist the user turn
  await db.insert(campaignTrainingMessages).values({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    trainingSessionId: input.sessionId,
    role: 'user',
    message: input.userMessage,
  } as NewCampaignTrainingMessage);

  // Build the rolling conversation. Cap at the last ~30 messages so we don't blow the prompt.
  const fresh = await getSession(input.workspaceId, input.campaignId, input.sessionId);
  const history = fresh.messages.slice(-30).map((m) => ({
    role: (m.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
    content: m.message,
  }));

  // Pull just enough campaign context to anchor the AI
  const context = await buildContext({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
  });

  const anthropic = getAnthropic();
  const response = await anthropic.messages.create({
    model: env().ANTHROPIC_MODEL_LIGHT,
    max_tokens: 1024,
    system: `${TRAINING_SYSTEM_PROMPT}\n\n## Campaign context\n\n${JSON.stringify(
      { workspace: context.workspace, campaign: context.campaign, playbook: context.playbook },
      null,
      2,
    )}`,
    messages: history,
  });

  const message = response as { content: Array<{ type: string; text?: string }> };
  const replyText = message.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
  if (!replyText) throw new AppError('AI returned empty training reply', 502);

  await db.insert(campaignTrainingMessages).values({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    trainingSessionId: input.sessionId,
    role: 'assistant',
    message: replyText,
  } as NewCampaignTrainingMessage);

  // Log a lightweight ai_actions row so the cost is traceable
  await db.insert(aiActions).values({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    actionType: 'generate_reply',
    status: 'completed',
    reason: 'training_chat_turn',
    completedAt: new Date(),
  });

  return { session: await getSession(input.workspaceId, input.campaignId, input.sessionId), reply: replyText };
}

// ---- approve ----

export async function approveSession(
  workspaceId: string,
  campaignId: string,
  sessionId: string,
): Promise<TrainingSessionWithMessages> {
  const db = getDb();
  const session = await getSession(workspaceId, campaignId, sessionId);
  if (session.status === 'completed') return session;

  await db
    .update(campaignTrainingSessions)
    .set({ status: 'completed', approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(campaignTrainingSessions.id, sessionId));

  // Move the campaign forward if it was still in training
  await db
    .update(campaigns)
    .set({ status: 'needs_review', updatedAt: new Date() })
    .where(eq(campaigns.id, campaignId));

  return getSession(workspaceId, campaignId, sessionId);
}

/** Roll up the conversation into a single string for the heavy AI to consume. */
export function transcript(session: TrainingSessionWithMessages, maxChars = 12000): string {
  const lines = session.messages.map((m) => `${m.role.toUpperCase()}: ${m.message}`);
  const joined = lines.join('\n\n');
  return joined.length <= maxChars ? joined : joined.slice(joined.length - maxChars);
}
