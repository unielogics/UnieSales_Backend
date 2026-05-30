/**
 * campaign_ai_behavior — get / upsert / approve service.
 *
 * One row per campaign. The `cards` JSONB is the authoritative per-card
 * configuration: status (draft / needs_setup / approved), summary text, and
 * a structured rule_payload the runtime reads.
 *
 * The post-intake runner and other runtime services consult `getByCampaign`
 * at decision points; missing or `draft`/`needs_setup` cards mean fall back
 * to safe defaults (Draft Only, no auto-send).
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/db';
import {
  campaignAiBehavior,
  type CampaignAiBehavior,
  type AiBehaviorCards,
  type AiBehaviorCardKey,
  type AiBehaviorCard,
  AI_BEHAVIOR_CARD_KEYS,
} from '../db/schema/campaign-ai-behavior';
import { NotFoundError } from '../utils/errors';

/**
 * Default seed cards for a brand-new campaign. Every card starts in
 * `needs_setup` with a generic safe-default summary. The operator either
 * approves them as-is, edits, or runs Generate-from-Training to overwrite.
 */
function defaultCards(): AiBehaviorCards {
  const stamp = new Date().toISOString();
  const make = (summary: string): AiBehaviorCard => ({
    status: 'needs_setup',
    summary,
    rule_payload: {},
    generated_at: stamp,
    approved_at: null,
    approved_by: null,
  });
  return {
    lead_intelligence: make(
      'Score 5 if the lead has a valid business email, company name, and at least one of: clear intent in source_notes, intent-rich custom_fields, or high-priority intake source (warehouse_review, audit, audit_request).',
    ),
    first_response: make(
      'Default to Draft Only — the AI generates a draft and creates a `review_ai_draft` task. Operator approves before any outbound is sent. No auto-send until this card is Approved and the campaign is in Safe Auto mode.',
    ),
    email_followup: make(
      `Skip until First Response is approved. Once unlocked, follow up at the campaign cadence with the AI's queued draft, paused when the lead replies manually.`,
    ),
    booking_behavior: make(
      'Send the campaign-linked booking offer when the lead expresses intent in the form (e.g. "wants_demo", "audit_request") or replies asking for next steps. No booking page configured yet — connect one to enable.',
    ),
    form_behavior: make(
      'Inbound campaigns map (site, tag) → this campaign automatically. New form fields land in lead.custom_fields verbatim. The AI may reference any value naturally in outbound copy.',
    ),
    task_creation: make(
      'Create a `review_ai_draft` task on every new inbound lead. Create `request_missing_info` if the contact lacks a phone or company. Create `handoff` if a Handoff trigger fires.',
    ),
    note_creation: make(
      'AI writes an `intake_summary` note on every new lead (already wired). Add `reply_summary` after each AI-classified reply. `meeting_prep` 30 minutes before a booked call.',
    ),
    handoff: make(
      'Hand off to a human on: pricing detail requests, legal/contract questions, enterprise sizing, sensitive topics, low classification confidence, or explicit objection categories.',
    ),
    exit_logic: make(
      'Close the lead after 5 follow-ups without a reply, after a hard bounce, on explicit STOP/unsubscribe, or on a clear bad-fit reply.',
    ),
    ai_safety: make(
      'Never invent pricing, guarantees, legal terms, revenue shares, or unsupported claims. Reference only campaign knowledge files and lead-supplied data.',
    ),
  };
}

/** Fetch the row for a campaign; creates it lazily with default cards if missing. */
export async function getByCampaign(
  workspaceId: string,
  campaignId: string,
): Promise<CampaignAiBehavior> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaignAiBehavior)
    .where(
      and(
        eq(campaignAiBehavior.workspaceId, workspaceId),
        eq(campaignAiBehavior.campaignId, campaignId),
      ),
    )
    .limit(1);
  if (rows[0]) return rows[0];

  // Lazy-create. Idempotent via the unique index on campaign_id.
  try {
    const [created] = await db
      .insert(campaignAiBehavior)
      .values({
        workspaceId,
        campaignId,
        cards: defaultCards(),
      })
      .returning();
    if (created) return created;
  } catch (err) {
    // Concurrent insert raced — re-read.
    if ((err as { code?: string }).code !== '23505') throw err;
  }
  const refetched = await db
    .select()
    .from(campaignAiBehavior)
    .where(
      and(
        eq(campaignAiBehavior.workspaceId, workspaceId),
        eq(campaignAiBehavior.campaignId, campaignId),
      ),
    )
    .limit(1);
  if (!refetched[0]) throw new NotFoundError('AI Behavior row missing after lazy-create race');
  return refetched[0];
}

export interface UpsertCardInput {
  key: AiBehaviorCardKey;
  status?: AiBehaviorCard['status'];
  summary?: string;
  rule_payload?: Record<string, unknown>;
  /** If status flips to 'approved', stamp these. */
  approved_by?: string | null;
}

/**
 * Update one card. The whole `cards` JSONB is rewritten with the merged
 * value because Postgres jsonb doesn't have a typed deep-merge primitive in
 * vanilla SQL.
 */
export async function upsertCard(
  workspaceId: string,
  campaignId: string,
  input: UpsertCardInput,
): Promise<CampaignAiBehavior> {
  if (!AI_BEHAVIOR_CARD_KEYS.includes(input.key)) {
    throw new NotFoundError(`Unknown card key: ${input.key}`);
  }
  const current = await getByCampaign(workspaceId, campaignId);
  const cards = { ...(current.cards ?? {}) } as AiBehaviorCards;
  const existing = cards[input.key] ?? {
    status: 'draft',
    summary: '',
  };

  const merged: AiBehaviorCard = {
    ...existing,
    ...(input.status != null ? { status: input.status } : {}),
    ...(input.summary != null ? { summary: input.summary } : {}),
    ...(input.rule_payload != null ? { rule_payload: input.rule_payload } : {}),
  };

  // Stamp approval transitions.
  if (input.status === 'approved') {
    merged.approved_at = new Date().toISOString();
    merged.approved_by = input.approved_by ?? null;
  } else if (input.status) {
    // Edited away from approved → clear the stamp so the UI shows it as draft.
    merged.approved_at = null;
    merged.approved_by = null;
  }

  cards[input.key] = merged;

  const db = getDb();
  const [updated] = await db
    .update(campaignAiBehavior)
    .set({ cards, updatedAt: new Date() })
    .where(eq(campaignAiBehavior.id, current.id))
    .returning();
  if (!updated) throw new NotFoundError('AI Behavior row vanished during update');
  return updated;
}

/** Returns true if every runtime-critical card is approved. */
export function isAutoSendReady(row: CampaignAiBehavior): boolean {
  const REQUIRED: AiBehaviorCardKey[] = [
    'lead_intelligence',
    'first_response',
    'booking_behavior',
    'handoff',
  ];
  const cards = row.cards ?? {};
  return REQUIRED.every((k) => cards[k]?.status === 'approved');
}
