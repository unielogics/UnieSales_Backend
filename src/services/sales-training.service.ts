/**
 * Sales Training service.
 *
 * One profile per product (or per intake form). Operator trains via chat,
 * curates FAQs / Behavior / Cross-sell / Knowledge, then clicks Generate to
 * consolidate everything into a trained_summary the AI runtime reads.
 *
 * Public surfaces:
 *   - list / get / create / update / remove        — profile CRUD
 *   - sendMessage                                  — chat loop
 *   - generateSummary                              — produces trained_summary
 *   - listKnowledge / addKnowledge / updateKnowledge / removeKnowledge
 *   - getForRuntime(workspaceId, site, tag)        — read used by ai-context.service
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { getDb } from '../config/db';
import { getAnthropic } from '../config/anthropic';
import { env } from '../config/env';
import { ConflictError, NotFoundError, ValidationError, AppError } from '../utils/errors';
import { extractText } from './extraction.service';
import {
  salesTrainingProfiles,
  salesTrainingMessages,
  salesTrainingKnowledge,
  type SalesTrainingProfile,
  type SalesTrainingMessage,
  type SalesTrainingKnowledge,
  type Faq,
  type Behavior,
  type SalesTrainingStatus,
  KNOWLEDGE_CONTENT_MAX,
} from '../db/schema/sales-training';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;

// Per-product list of intake forms that flow into the training profile for
// that product. Used by the kickoff prompt so the AI knows the breadth of
// channels feeding the same product knowledge. Keep in sync with
// config/intake-routing.ts and the frontend's intake-urls.ts helper.
const INTAKE_ROUTES_BY_SITE: Record<string, string[]> = {
  uniewms: [
    'uniewms.com/talk-to-sales',
    'uniewms.com/broker-program/apply',
    'uniewms.com/warehouse-review',
  ],
  unielogics: [
    'unielogics.com/audit',
    'unielogics.com/join',
    'unielogics.com/get-started',
    'unielogics.com/ (developer footer widget)',
    'unielogics.com/industry-problems',
    'unielogics.com/products',
    'unielogics.com/services',
  ],
  uniecortex: [
    'uniecortex.com/audit (HMAC mirror)',
    'uniecortex.com/partners (HMAC mirror)',
  ],
  unieconnect: [
    // No public intake forms yet — operator is training ahead of launch.
  ],
};

function ensureValidSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new ValidationError('Invalid slug', [
      { field: 'slug', reason: 'lowercase letters, digits, dashes; 2-60 chars; starts alphanumeric' },
    ]);
  }
}

// ─── List view ────────────────────────────────────────────────────────────
export interface ProfileListItem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sourceSite: string | null;
  sourceTag: string | null;
  status: SalesTrainingStatus;
  faqCount: number;
  messageCount: number;
  crossSellCount: number;
  knowledgeCount: number;
  trainedAt: string | null;
  seedProtected: boolean;
  disabled: boolean;
}

export async function list(workspaceId: string): Promise<ProfileListItem[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: salesTrainingProfiles.id,
      slug: salesTrainingProfiles.slug,
      name: salesTrainingProfiles.name,
      description: salesTrainingProfiles.description,
      sourceSite: salesTrainingProfiles.sourceSite,
      sourceTag: salesTrainingProfiles.sourceTag,
      status: salesTrainingProfiles.status,
      faqs: salesTrainingProfiles.faqs,
      crossSell: salesTrainingProfiles.crossSell,
      trainedAt: salesTrainingProfiles.trainedAt,
      seedProtected: salesTrainingProfiles.seedProtected,
      disabled: salesTrainingProfiles.disabled,
    })
    .from(salesTrainingProfiles)
    .where(eq(salesTrainingProfiles.workspaceId, workspaceId))
    .orderBy(asc(salesTrainingProfiles.name));

  // Counters in two cheap aggregate queries — avoids correlated subselects.
  const ids = rows.map((r) => r.id);
  const msgCounts = ids.length
    ? await db
        .select({
          profileId: salesTrainingMessages.profileId,
          n: sql<number>`count(*)::int`,
        })
        .from(salesTrainingMessages)
        .where(inArray(salesTrainingMessages.profileId, ids))
        .groupBy(salesTrainingMessages.profileId)
    : [];
  const knCounts = ids.length
    ? await db
        .select({
          profileId: salesTrainingKnowledge.profileId,
          n: sql<number>`count(*)::int`,
        })
        .from(salesTrainingKnowledge)
        .where(inArray(salesTrainingKnowledge.profileId, ids))
        .groupBy(salesTrainingKnowledge.profileId)
    : [];
  const mMap = new Map(msgCounts.map((c) => [c.profileId, c.n]));
  const kMap = new Map(knCounts.map((c) => [c.profileId, c.n]));

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    sourceSite: r.sourceSite,
    sourceTag: r.sourceTag,
    status: r.status,
    faqCount: Array.isArray(r.faqs) ? r.faqs.length : 0,
    messageCount: mMap.get(r.id) ?? 0,
    crossSellCount: Array.isArray(r.crossSell) ? r.crossSell.length : 0,
    knowledgeCount: kMap.get(r.id) ?? 0,
    trainedAt: r.trainedAt ? r.trainedAt.toISOString() : null,
    seedProtected: r.seedProtected,
    disabled: r.disabled,
  }));
}

// ─── Toggle disabled flag ─────────────────────────────────────────────────
// "Disabled" means AI does not handle inbound leads for this (site, tag):
//   - getForRuntime returns null  (training never reaches AI tasks)
//   - post-intake-runner creates a human_handoff task instead of
//     review_ai_draft
// Allowed on seeded profiles — disabling is the whole point of the flag.
export async function setDisabled(
  workspaceId: string,
  profileId: string,
  disabled: boolean,
): Promise<SalesTrainingProfile> {
  const db = getDb();
  await fetchProfile(workspaceId, profileId);
  const [updated] = await db
    .update(salesTrainingProfiles)
    .set({ disabled, updatedAt: new Date() })
    .where(
      and(
        eq(salesTrainingProfiles.id, profileId),
        eq(salesTrainingProfiles.workspaceId, workspaceId),
      ),
    )
    .returning();
  if (!updated) throw new NotFoundError('Training profile not found');
  return updated;
}

// ─── Detail ───────────────────────────────────────────────────────────────
export async function get(
  workspaceId: string,
  profileId: string,
): Promise<{
  profile: SalesTrainingProfile;
  messages: SalesTrainingMessage[];
  knowledge: SalesTrainingKnowledge[];
}> {
  const db = getDb();
  const rows = await db
    .select()
    .from(salesTrainingProfiles)
    .where(
      and(
        eq(salesTrainingProfiles.id, profileId),
        eq(salesTrainingProfiles.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  const profile = rows[0];
  if (!profile) throw new NotFoundError('Training profile not found');

  const messages = await db
    .select()
    .from(salesTrainingMessages)
    .where(eq(salesTrainingMessages.profileId, profileId))
    .orderBy(asc(salesTrainingMessages.createdAt));

  const knowledge = await db
    .select()
    .from(salesTrainingKnowledge)
    .where(eq(salesTrainingKnowledge.profileId, profileId))
    .orderBy(asc(salesTrainingKnowledge.ordinal), asc(salesTrainingKnowledge.createdAt));

  return { profile, messages, knowledge };
}

// ─── Create custom profile ────────────────────────────────────────────────
export interface CreateInput {
  slug: string;
  name: string;
  description?: string;
  sourceSite?: string;
  sourceTag?: string;
}

export async function create(
  workspaceId: string,
  input: CreateInput,
): Promise<SalesTrainingProfile> {
  ensureValidSlug(input.slug);
  if ((input.sourceSite && !input.sourceTag) || (!input.sourceSite && input.sourceTag)) {
    throw new ValidationError('Source binding must include both site and tag', [
      { field: 'sourceTag', reason: 'must be paired with sourceSite' },
    ]);
  }
  const db = getDb();
  try {
    const [created] = await db
      .insert(salesTrainingProfiles)
      .values({
        workspaceId,
        slug: input.slug,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        sourceSite: input.sourceSite ?? null,
        sourceTag: input.sourceTag ?? null,
        seedProtected: false,
      })
      .returning();
    if (!created) throw new AppError('Profile insert returned no row', 500);
    return created;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new ConflictError('A profile with that slug or source already exists', [
        { field: 'slug', reason: 'taken' },
      ]);
    }
    throw err;
  }
}

// ─── Update (PATCH semantics) ─────────────────────────────────────────────
export interface UpdateInput {
  name?: string;
  description?: string | null;
  faqs?: Faq[];
  behavior?: Behavior;
  crossSell?: string[];
}

export async function update(
  workspaceId: string,
  profileId: string,
  patch: UpdateInput,
): Promise<SalesTrainingProfile> {
  const db = getDb();
  const existing = await fetchProfile(workspaceId, profileId);

  // Any content edit while status=trained means the trained_summary is stale.
  // Flip back to 'in_progress' so the operator knows to regenerate. The
  // runtime stops using the profile because getForRuntime requires 'trained'.
  const contentDrift =
    patch.faqs !== undefined ||
    patch.behavior !== undefined ||
    patch.crossSell !== undefined;
  const nextStatus: SalesTrainingStatus | undefined =
    contentDrift && existing.status === 'trained' ? 'in_progress' : undefined;

  const update: Partial<typeof salesTrainingProfiles.$inferInsert> = {
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.description !== undefined
      ? { description: patch.description == null ? null : patch.description.trim() || null }
      : {}),
    ...(patch.faqs !== undefined ? { faqs: patch.faqs } : {}),
    ...(patch.behavior !== undefined ? { behavior: patch.behavior } : {}),
    ...(patch.crossSell !== undefined ? { crossSell: patch.crossSell } : {}),
    ...(nextStatus ? { status: nextStatus } : {}),
    updatedAt: new Date(),
  };
  const [updated] = await db
    .update(salesTrainingProfiles)
    .set(update)
    .where(
      and(
        eq(salesTrainingProfiles.id, profileId),
        eq(salesTrainingProfiles.workspaceId, workspaceId),
      ),
    )
    .returning();
  if (!updated) throw new NotFoundError('Training profile not found');
  return updated;
}

// ─── Delete ───────────────────────────────────────────────────────────────
export async function remove(workspaceId: string, profileId: string): Promise<void> {
  const db = getDb();
  const existing = await fetchProfile(workspaceId, profileId);
  if (existing.seedProtected) {
    throw new ConflictError(
      "This product is bound to a live intake form and can't be removed.",
      [{ field: 'profile', reason: 'seed_protected' }],
    );
  }
  await db
    .delete(salesTrainingProfiles)
    .where(
      and(
        eq(salesTrainingProfiles.id, profileId),
        eq(salesTrainingProfiles.workspaceId, workspaceId),
      ),
    );
}

// ─── Chat loop ────────────────────────────────────────────────────────────
const TRAINING_SYSTEM_PROMPT = `You are an AI sales strategist helping the operator train UnieSales for a specific product or intake form. Your job is to extract the knowledge a junior sales rep would need to handle inbound leads for this product well — what it does, who it's for, common objections, pricing posture, demo flow, deal-killers, edge cases, and when to hand off to a human.

You are NOT writing emails or talking to leads. You are interviewing the operator and recording their knowledge.

Style:
- One focused question per turn. Don't dump checklists.
- Probe specifics. If the operator says "we handle pricing carefully," ask exactly what they say when a lead asks for a price up front.
- Challenge weak setup. If they leave a critical gap (no demo flow, no handoff rule, no disqualifier criteria), name it.
- Suggest cross-sell candidates from the workspace's other profiles when context warrants — but check before assuming.
- Operators are busy; keep replies under 6 lines unless they ask for depth.

When the operator has covered enough ground (you'll feel this around message 8-15), tell them: "I think we've got enough to generate the trained summary for this product. Hit Generate Summary below to lock it in."`;

const MAX_HISTORY = 30;

export async function sendMessage(
  workspaceId: string,
  profileId: string,
  userContent: string,
): Promise<{
  userMessage: SalesTrainingMessage;
  assistantMessage: SalesTrainingMessage;
}> {
  const content = userContent.trim();
  if (!content) throw new ValidationError('Message is empty', [{ field: 'content', reason: 'required' }]);
  if (content.length > 8000) {
    throw new ValidationError('Message too long', [{ field: 'content', reason: 'max 8000 chars' }]);
  }

  const db = getDb();
  const profile = await fetchProfile(workspaceId, profileId);

  // Persist the user turn first so it survives an Anthropic failure.
  const [userRow] = await db
    .insert(salesTrainingMessages)
    .values({ profileId, role: 'user', content })
    .returning();
  if (!userRow) throw new AppError('User message insert failed', 500);

  // Bump status from needs_setup → in_progress on first user message.
  if (profile.status === 'needs_setup') {
    await db
      .update(salesTrainingProfiles)
      .set({ status: 'in_progress', updatedAt: new Date() })
      .where(eq(salesTrainingProfiles.id, profileId));
  }

  // Build history (last N turns) for the model.
  const history = await db
    .select({ role: salesTrainingMessages.role, content: salesTrainingMessages.content })
    .from(salesTrainingMessages)
    .where(eq(salesTrainingMessages.profileId, profileId))
    .orderBy(desc(salesTrainingMessages.createdAt))
    .limit(MAX_HISTORY);
  history.reverse();

  // Snapshot profile state for the system prompt.
  const profileContext = {
    name: profile.name,
    description: profile.description,
    source_binding: profile.sourceSite
      ? `${profile.sourceSite}.${profile.sourceTag}`
      : 'custom — no inbound form',
    faqs_configured: Array.isArray(profile.faqs) ? profile.faqs.length : 0,
    behavior_cards_set: profile.behavior
      ? Object.values(profile.behavior as Record<string, unknown>).filter((v) => !!v).length
      : 0,
    cross_sells_set: Array.isArray(profile.crossSell) ? profile.crossSell.length : 0,
  };

  const anthropic = getAnthropic();
  const response = await anthropic.messages.create({
    model: env().ANTHROPIC_MODEL_HEAVY,
    max_tokens: 800,
    system: `${TRAINING_SYSTEM_PROMPT}\n\n## Current profile\n\n${JSON.stringify(profileContext, null, 2)}`,
    messages: history.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })) as Array<{ role: 'user' | 'assistant'; content: string }>,
  });

  const blocks = (response as { content: Array<{ type: string; text?: string }> }).content;
  const replyText = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
  if (!replyText) throw new AppError('AI returned empty reply', 502);

  const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  const [assistantRow] = await db
    .insert(salesTrainingMessages)
    .values({
      profileId,
      role: 'assistant',
      content: replyText,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
    })
    .returning();
  if (!assistantRow) throw new AppError('Assistant message insert failed', 500);

  return { userMessage: userRow, assistantMessage: assistantRow };
}

// ─── Kickoff: AI opens the conversation ──────────────────────────────────
// When the operator first opens a profile we want the AI to greet them and
// start interviewing — they shouldn't have to type "hi" to get the strategist
// talking. This generates a single assistant turn (no user turn) using the
// existing TRAINING_SYSTEM_PROMPT plus the profile's current state, then
// persists it. Idempotent: returns the existing first assistant message if
// the chat is already non-empty.
export async function kickoffChat(
  workspaceId: string,
  profileId: string,
): Promise<SalesTrainingMessage> {
  const db = getDb();
  const profile = await fetchProfile(workspaceId, profileId);

  const existing = await db
    .select()
    .from(salesTrainingMessages)
    .where(eq(salesTrainingMessages.profileId, profileId))
    .orderBy(asc(salesTrainingMessages.createdAt))
    .limit(1);
  if (existing.length > 0) {
    // Chat already has at least one turn — return the first message as a
    // no-op so the frontend can safely call kickoff on every visit.
    return existing[0]!;
  }

  // Build a context-rich kickoff prompt. The model gets the profile state
  // and a one-shot instruction to open the interview with a single specific
  // question (not a checklist dump).
  //
  // For product-level profiles (source_tag IS NULL) we list every intake
  // route that flows into this product so the AI understands the breadth
  // upfront — different forms surface different intents (audit vs. broker
  // vs. talk-to-sales) but they all train the same product knowledge.
  const intakeRoutes = profile.sourceSite
    ? INTAKE_ROUTES_BY_SITE[profile.sourceSite] ?? []
    : [];
  const profileContext = {
    name: profile.name,
    description: profile.description,
    product_site: profile.sourceSite ?? 'custom (no public intake)',
    intake_forms_routing_here: intakeRoutes.length > 0 ? intakeRoutes : '(none yet)',
    faqs_configured: Array.isArray(profile.faqs) ? profile.faqs.length : 0,
    behavior_cards_set: profile.behavior
      ? Object.values(profile.behavior as Record<string, unknown>).filter((v) => !!v).length
      : 0,
    cross_sells_set: Array.isArray(profile.crossSell) ? profile.crossSell.length : 0,
  };

  // Knowledge count gives the model another signal about how much the
  // operator has already loaded — if they uploaded a 20k-char product spec
  // before opening the chat, the kickoff should acknowledge that and probe
  // gaps instead of asking "so what is this product".
  const knowledgeCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(salesTrainingKnowledge)
    .where(eq(salesTrainingKnowledge.profileId, profileId))
    .then((r) => r[0]?.n ?? 0);

  const kickoffInstruction = `Greet the operator briefly (one sentence, no preamble) and ask ONE focused opening question to start learning about this product. Pick your opening based on the state above:

- If there's a source binding (an intake form), reference it by name and ask what kind of leads they typically get from that form.
- If FAQs/behavior/knowledge is already configured (counts above 0), acknowledge that and probe the gap (e.g. ask about a missing behavior field, or ask them to walk through a recent good lead).
- If everything is empty (a brand-new profile), ask the broadest possible foundational question: "What does this product do, in one sentence?"

End with the actual question. No bullet lists. Under 4 lines total.`;

  const anthropic = getAnthropic();
  const response = await anthropic.messages.create({
    model: env().ANTHROPIC_MODEL_HEAVY,
    max_tokens: 400,
    system: `${TRAINING_SYSTEM_PROMPT}\n\n## Current profile\n\n${JSON.stringify({ ...profileContext, knowledge_entries: knowledgeCount }, null, 2)}\n\n## Your task right now\n\n${kickoffInstruction}`,
    messages: [
      // The model needs at least one user-role turn; we send a synthetic one
      // that just tells it to begin. It never gets persisted.
      { role: 'user' as const, content: '[Operator just opened this profile — kick off the training interview.]' },
    ],
  });

  const blocks = (response as { content: Array<{ type: string; text?: string }> }).content;
  const replyText = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
  if (!replyText) throw new AppError('AI returned empty kickoff', 502);

  const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  const [assistantRow] = await db
    .insert(salesTrainingMessages)
    .values({
      profileId,
      role: 'assistant',
      content: replyText,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
    })
    .returning();
  if (!assistantRow) throw new AppError('Kickoff insert failed', 500);

  // Bump status from needs_setup → in_progress on first AI turn too, so the
  // list view reflects "engaged" the moment the operator opens the chat.
  if (profile.status === 'needs_setup') {
    await db
      .update(salesTrainingProfiles)
      .set({ status: 'in_progress', updatedAt: new Date() })
      .where(eq(salesTrainingProfiles.id, profileId));
  }

  return assistantRow;
}

// ─── Generate trained summary ─────────────────────────────────────────────
export async function generateSummary(
  workspaceId: string,
  profileId: string,
): Promise<{ summary: string; trainedAt: Date }> {
  const db = getDb();
  const profile = await fetchProfile(workspaceId, profileId);

  const messages = await db
    .select({ role: salesTrainingMessages.role, content: salesTrainingMessages.content })
    .from(salesTrainingMessages)
    .where(eq(salesTrainingMessages.profileId, profileId))
    .orderBy(asc(salesTrainingMessages.createdAt));

  const knowledge = await db
    .select()
    .from(salesTrainingKnowledge)
    .where(eq(salesTrainingKnowledge.profileId, profileId))
    .orderBy(asc(salesTrainingKnowledge.ordinal), asc(salesTrainingKnowledge.createdAt));

  // Gate: profile must have *some* substantive content before generation.
  // Either a real chat (≥2 turns), or curated structured data on the right
  // panel (FAQs / Behavior / Knowledge). Cross-sell alone isn't enough since
  // it's just links to other products. Operators who imported PDFs into
  // FAQs/Behavior/Knowledge can generate without ever chatting.
  const faqsForGate = (profile.faqs ?? []) as Faq[];
  const behaviorForGate = (profile.behavior ?? {}) as Behavior;
  const behaviorSetCount = (
    [behaviorForGate.pricing, behaviorForGate.demo, behaviorForGate.followup, behaviorForGate.handoff] as Array<string | undefined>
  ).filter((v) => typeof v === 'string' && v.trim().length > 0).length;
  const hasChat = messages.length >= 2;
  const hasStructured =
    faqsForGate.length > 0 || behaviorSetCount > 0 || knowledge.length > 0;
  if (!hasChat && !hasStructured) {
    throw new ValidationError(
      'No training content yet',
      [
        {
          field: 'content',
          reason:
            'Add at least one FAQ, behavior rule, or knowledge entry — or have a back-and-forth in the chat.',
        },
      ],
    );
  }

  // Render the summary input.
  const faqs = (profile.faqs ?? []) as Faq[];
  const behavior = (profile.behavior ?? {}) as Behavior;
  const crossSell = (profile.crossSell ?? []) as string[];

  const faqBlock =
    faqs.length === 0
      ? '(none)'
      : faqs.map((f, i) => `${i + 1}. Q: ${f.q}\n   A: ${f.a}`).join('\n');
  const behaviorBlock =
    [
      `Pricing handling: ${behavior.pricing || '(unset)'}`,
      `Demo handling: ${behavior.demo || '(unset)'}`,
      `Follow-up cadence: ${behavior.followup || '(unset)'}`,
      `Handoff triggers: ${behavior.handoff || '(unset)'}`,
    ].join('\n');
  const crossSellBlock = crossSell.length === 0 ? '(none)' : crossSell.join(', ');
  // Cap knowledge fed into the digest: ~6k chars/entry, ~40k total. The digest
  // distills — it doesn't need the full 20k-char verbatim entries, and this
  // keeps the (Sonnet) generateSummary call from ballooning to 100k+ tokens.
  const KN_PER = 6000;
  const KN_TOTAL = 40000;
  let knUsed = 0;
  const knowledgeBlock =
    knowledge.length === 0
      ? '(none)'
      : knowledge
          .map((k) => {
            if (knUsed >= KN_TOTAL) return null;
            const body =
              k.content.length > KN_PER ? k.content.slice(0, KN_PER) + '…[trimmed]' : k.content;
            knUsed += body.length;
            return `### ${k.title}\n${body}`;
          })
          .filter((b): b is string => b !== null)
          .join('\n\n---\n\n');
  // Only the last 40 turns — older chat is low-signal for a one-shot digest.
  const recentMsgs = messages.length > 40 ? messages.slice(-40) : messages;
  const transcript =
    messages.length === 0
      ? '(no chat — the operator provided structured data only; rely on the FAQs, Behavior rules, and Knowledge entries above)'
      : recentMsgs.map((m) => `[${m.role.toUpperCase()}] ${m.content}`).join('\n\n');

  const userPrompt = `Product profile:
- Name: ${profile.name}
- Description: ${profile.description ?? '(none)'}
- Bound to intake form: ${profile.sourceSite ? `${profile.sourceSite}.${profile.sourceTag}` : 'custom — no inbound form'}

Operator-curated FAQs (quote verbatim when relevant):
${faqBlock}

Behavior rules:
${behaviorBlock}

Cross-sell candidates (mention naturally when context warrants):
${crossSellBlock}

Knowledge entries (operator-curated long-form reference; quote verbatim when a lead asks something they cover):
${knowledgeBlock}

Full training conversation transcript:
${transcript}

---

Output a Markdown digest, 600–1200 words, with these sections:
1. **What the product is** — one paragraph, plain English, no marketing fluff.
2. **Who it's for** — ICP signals, must-haves, disqualifiers.
3. **Pricing posture** — what to say, what to defer, what triggers handoff.
4. **Demo flow** — when to offer, what the demo covers, length, who attends.
5. **Common objections** — list 3–6 with the agreed response style.
6. **Cross-sell openings** — when to mention adjacent products from the list above.
7. **Hard rules** — anything the AI must never claim, promise, or commit to.

Be concrete. Cite numbers, deadlines, specific phrases the operator used. Don't pad.`;

  const anthropic = getAnthropic();
  const response = await anthropic.messages.create({
    model: env().ANTHROPIC_MODEL_HEAVY,
    max_tokens: 4000,
    system:
      'You are condensing a sales-training session into a knowledge digest that UnieSales\'s AI will read every time an inbound lead arrives for this product. The digest is the single source of truth for AI behavior on this product — everything not in here, the AI won\'t know. Be concrete; don\'t add filler.',
    messages: [{ role: 'user', content: userPrompt }],
  });

  const blocks = (response as { content: Array<{ type: string; text?: string }> }).content;
  const summary = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
  if (!summary) throw new AppError('AI returned empty summary', 502);

  const trainedAt = new Date();
  await db
    .update(salesTrainingProfiles)
    .set({
      trainedSummary: summary,
      status: 'trained',
      trainedAt,
      updatedAt: trainedAt,
    })
    .where(eq(salesTrainingProfiles.id, profileId));

  return { summary, trainedAt };
}

// ─── Knowledge CRUD ────────────────────────────────────────────────────────
export async function listKnowledge(
  workspaceId: string,
  profileId: string,
): Promise<SalesTrainingKnowledge[]> {
  await fetchProfile(workspaceId, profileId);
  const db = getDb();
  return db
    .select()
    .from(salesTrainingKnowledge)
    .where(eq(salesTrainingKnowledge.profileId, profileId))
    .orderBy(asc(salesTrainingKnowledge.ordinal), asc(salesTrainingKnowledge.createdAt));
}

export async function addKnowledge(
  workspaceId: string,
  profileId: string,
  input: { title: string; content: string },
): Promise<SalesTrainingKnowledge> {
  validateKnowledge(input);
  const profile = await fetchProfile(workspaceId, profileId);
  const db = getDb();

  // Determine next ordinal (max+1).
  const max = await db
    .select({ m: sql<number>`COALESCE(MAX(ordinal), -1)::int` })
    .from(salesTrainingKnowledge)
    .where(eq(salesTrainingKnowledge.profileId, profileId));
  const ordinal = (max[0]?.m ?? -1) + 1;

  const [created] = await db
    .insert(salesTrainingKnowledge)
    .values({
      profileId,
      title: input.title.trim(),
      content: input.content,
      ordinal,
      sourceType: 'typed',
    })
    .returning();
  if (!created) throw new AppError('Knowledge insert returned no row', 500);

  // Content drift — flip trained → in_progress so the operator regenerates.
  if (profile.status === 'trained') {
    await db
      .update(salesTrainingProfiles)
      .set({ status: 'in_progress', updatedAt: new Date() })
      .where(eq(salesTrainingProfiles.id, profileId));
  }
  return created;
}

export async function updateKnowledge(
  workspaceId: string,
  profileId: string,
  knowledgeId: string,
  patch: { title?: string; content?: string; ordinal?: number },
): Promise<SalesTrainingKnowledge> {
  if (patch.title !== undefined || patch.content !== undefined) {
    validateKnowledge({
      title: patch.title ?? 'placeholder',
      content: patch.content ?? '',
    });
    // Title-only update can have empty content in `patch`, which is fine —
    // the DB CHECK only fires on what we actually write.
  }
  const profile = await fetchProfile(workspaceId, profileId);
  const db = getDb();

  const update: Partial<typeof salesTrainingKnowledge.$inferInsert> = {
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(patch.ordinal !== undefined ? { ordinal: patch.ordinal } : {}),
    updatedAt: new Date(),
  };
  const [updated] = await db
    .update(salesTrainingKnowledge)
    .set(update)
    .where(
      and(
        eq(salesTrainingKnowledge.id, knowledgeId),
        eq(salesTrainingKnowledge.profileId, profileId),
      ),
    )
    .returning();
  if (!updated) throw new NotFoundError('Knowledge entry not found');

  if (profile.status === 'trained' && (patch.title !== undefined || patch.content !== undefined)) {
    await db
      .update(salesTrainingProfiles)
      .set({ status: 'in_progress', updatedAt: new Date() })
      .where(eq(salesTrainingProfiles.id, profileId));
  }
  return updated;
}

export async function removeKnowledge(
  workspaceId: string,
  profileId: string,
  knowledgeId: string,
): Promise<void> {
  const profile = await fetchProfile(workspaceId, profileId);
  const db = getDb();
  const result = await db
    .delete(salesTrainingKnowledge)
    .where(
      and(
        eq(salesTrainingKnowledge.id, knowledgeId),
        eq(salesTrainingKnowledge.profileId, profileId),
      ),
    )
    .returning({ id: salesTrainingKnowledge.id });
  if (result.length === 0) throw new NotFoundError('Knowledge entry not found');
  if (profile.status === 'trained') {
    await db
      .update(salesTrainingProfiles)
      .set({ status: 'in_progress', updatedAt: new Date() })
      .where(eq(salesTrainingProfiles.id, profileId));
  }
}

/**
 * Ingest a file as a new Knowledge entry. Reuses the campaign-side extraction
 * pipeline (PDF / CSV / JSON / MD / TXT). Content is truncated to the 20,000
 * character cap; longer documents get a `[... trimmed ...]` marker so the
 * operator knows to split the source up if they need the full text.
 *
 * Title defaults to the filename minus extension. Operator can rename via
 * the regular Knowledge editor afterward.
 */
export async function addKnowledgeFromFile(
  workspaceId: string,
  profileId: string,
  input: { fileName: string; buffer: Buffer; mime?: string },
): Promise<SalesTrainingKnowledge> {
  const profile = await fetchProfile(workspaceId, profileId);
  if (!input.fileName?.trim()) {
    throw new ValidationError('Filename missing', [{ field: 'fileName', reason: 'required' }]);
  }
  if (!input.buffer || input.buffer.length === 0) {
    throw new ValidationError('Empty file', [{ field: 'file', reason: 'no content' }]);
  }

  const { text } = await extractText(input.buffer, input.fileName, input.mime);
  let content = (text ?? '').trim();
  if (content.length === 0) {
    throw new ValidationError('Could not extract text from this file', [
      { field: 'file', reason: 'no extractable text — try TXT/MD/PDF/DOCX/CSV' },
    ]);
  }
  if (content.length > KNOWLEDGE_CONTENT_MAX) {
    content = content.slice(0, KNOWLEDGE_CONTENT_MAX - 80) + '\n\n[… trimmed at 20,000 character cap]';
  }
  // Filename → title, max 120 chars. Strip extension for readability.
  const titleBase = input.fileName.replace(/\.[a-z0-9]{2,5}$/i, '').trim() || input.fileName;
  const title = titleBase.slice(0, 120);

  const db = getDb();
  const max = await db
    .select({ m: sql<number>`COALESCE(MAX(ordinal), -1)::int` })
    .from(salesTrainingKnowledge)
    .where(eq(salesTrainingKnowledge.profileId, profileId));
  const ordinal = (max[0]?.m ?? -1) + 1;
  const [created] = await db
    .insert(salesTrainingKnowledge)
    .values({
      profileId,
      title,
      content,
      ordinal,
      sourceType: 'file',
    })
    .returning();
  if (!created) throw new AppError('Knowledge insert returned no row', 500);

  if (profile.status === 'trained') {
    await db
      .update(salesTrainingProfiles)
      .set({ status: 'in_progress', updatedAt: new Date() })
      .where(eq(salesTrainingProfiles.id, profileId));
  }
  return created;
}

/**
 * Bulk-import FAQ Q/A pairs from an uploaded file. CSV with q+a columns
 * is parsed directly; PDF/TXT/MD route through Claude Sonnet which extracts
 * the Q/A pairs from free-form text. Either way, the resulting Faq[] merges
 * into the existing profile.faqs array (dedup by lowercased question text).
 */
export async function importFaqsFromFile(
  workspaceId: string,
  profileId: string,
  input: { fileName: string; buffer: Buffer; mime?: string },
): Promise<{ profile: SalesTrainingProfile; added: number; skipped: number; method: 'csv' | 'ai' }> {
  const profile = await fetchProfile(workspaceId, profileId);
  if (!input.buffer || input.buffer.length === 0) {
    throw new ValidationError('Empty file', [{ field: 'file', reason: 'no content' }]);
  }

  const lower = input.fileName.toLowerCase();
  const isCsv = lower.endsWith('.csv') || input.mime === 'text/csv';

  let incoming: Faq[];
  let method: 'csv' | 'ai';

  if (isCsv) {
    incoming = parseFaqsFromCsv(input.buffer.toString('utf-8'));
    method = 'csv';
    if (incoming.length === 0) {
      throw new ValidationError('No usable FAQ rows found', [
        { field: 'file', reason: 'CSV needs q+a (or question+answer) columns' },
      ]);
    }
  } else {
    // PDF / DOCX / TXT / MD — extract text, then let Claude pull the Q/A pairs.
    const { text } = await extractText(input.buffer, input.fileName, input.mime);
    const body = (text ?? '').trim();
    if (!body) {
      throw new ValidationError('Could not extract text from this file', [
        { field: 'file', reason: 'no extractable text' },
      ]);
    }
    incoming = await aiExtractFaqsFromText(body);
    method = 'ai';
    if (incoming.length === 0) {
      throw new ValidationError('No FAQ pairs found in this file', [
        { field: 'file', reason: 'AI scanned the document but found no Q/A pairs' },
      ]);
    }
  }

  // Merge: existing first, then incoming, deduped by lowercased q.
  const existing = (profile.faqs ?? []) as Faq[];
  const seen = new Map<string, Faq>();
  for (const f of existing) seen.set(f.q.trim().toLowerCase(), f);
  let added = 0;
  for (const f of incoming) {
    const key = f.q.toLowerCase();
    if (!seen.has(key)) added++;
    seen.set(key, f);
  }
  const merged = Array.from(seen.values()).slice(0, 80); // schema cap

  const next = await update(workspaceId, profileId, { faqs: merged });
  return { profile: next, added, skipped: incoming.length - added, method };
}

/** CSV → Faq[] (synchronous parser used when the file is .csv). */
function parseFaqsFromCsv(csvText: string): Faq[] {
  const rows = parseCsvSync(csvText, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  }) as Array<Record<string, string>>;
  const out: Faq[] = [];
  for (const r of rows) {
    const q = (r.q ?? r.question ?? '').trim();
    const a = (r.a ?? r.answer ?? '').trim();
    if (!q || !a) continue;
    if (q.length > 500) continue;
    out.push({ q, a: a.slice(0, 2000) });
  }
  return out;
}

/**
 * Claude Sonnet pass: given a chunk of free-form text (typical of a PDF
 * extract), return a JSON array of {q, a} objects. Used when the operator
 * uploads a non-CSV file for FAQ import — PDFs don't have a column structure
 * so we let the model find the Q/A pairs itself.
 *
 * Robust parsing: strips ``` fences if the model wraps the JSON, returns []
 * on any failure rather than throwing (caller surfaces a clean error).
 */
async function aiExtractFaqsFromText(text: string): Promise<Faq[]> {
  // Truncate aggressively to keep the request cheap. Most FAQ docs are <8k chars.
  const trimmed = text.length > 14000 ? text.slice(0, 14000) + '\n\n[…truncated]' : text;
  const anthropic = getAnthropic();
  const response = await anthropic.messages.create({
    model: env().ANTHROPIC_MODEL_HEAVY,
    max_tokens: 4000,
    system:
      'You extract FAQ entries from documents. Output ONLY a JSON array of {"q": string, "a": string} objects — no prose, no code fences. Each q is a single question (≤500 chars). Each a is the matching answer text (≤2000 chars). Skip filler/intro/headers. If no real Q/A pairs exist, return [].',
    messages: [
      {
        role: 'user',
        content: `Document:\n\n${trimmed}\n\n---\n\nReturn the JSON array now.`,
      },
    ],
  });
  const blocks = (response as { content: Array<{ type: string; text?: string }> }).content;
  const raw = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
  // Strip ``` fences if the model added them despite instructions.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Faq[] = [];
  for (const r of parsed) {
    if (!r || typeof r !== 'object') continue;
    const q = String((r as Record<string, unknown>).q ?? '').trim();
    const a = String((r as Record<string, unknown>).a ?? '').trim();
    if (!q || !a) continue;
    if (q.length > 500) continue;
    out.push({ q, a: a.slice(0, 2000) });
  }
  return out;
}

/** Back-compat alias — older callers used the CSV-only entry point. */
export async function importFaqsFromCsv(
  workspaceId: string,
  profileId: string,
  csvText: string,
): Promise<{ profile: SalesTrainingProfile; added: number; skipped: number }> {
  const buffer = Buffer.from(csvText, 'utf-8');
  const r = await importFaqsFromFile(workspaceId, profileId, {
    fileName: 'inline.csv',
    buffer,
    mime: 'text/csv',
  });
  return { profile: r.profile, added: r.added, skipped: r.skipped };
}

/**
 * Map an uploaded file into the four behavior fields. TXT/MD files run
 * through a regex-based section parser first (cheap, deterministic);
 * PDFs (and TXT/MD that lack recognizable section markers) fall back to
 * Claude Sonnet which maps the free-form content to the 4 fields.
 *
 * Recognized section names for the regex parser:
 *   - pricing / price / pricing handling
 *   - demo / demos / demo handling
 *   - followup / follow-up / follow-up cadence
 *   - handoff / hand-off / escalation
 *
 * Existing fields stay untouched for any section the file doesn't address.
 */
export async function importBehaviorFromFile(
  workspaceId: string,
  profileId: string,
  input: { fileName: string; buffer: Buffer; mime?: string },
): Promise<{
  profile: SalesTrainingProfile;
  updatedFields: Array<keyof Behavior>;
  method: 'sections' | 'ai';
}> {
  const profile = await fetchProfile(workspaceId, profileId);
  if (!input.buffer || input.buffer.length === 0) {
    throw new ValidationError('Empty file', [{ field: 'file', reason: 'no content' }]);
  }

  const lower = input.fileName.toLowerCase();
  const isPdf = lower.endsWith('.pdf') || input.mime === 'application/pdf';
  const isDocx =
    lower.endsWith('.docx') ||
    input.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const { text } = await extractText(input.buffer, input.fileName, input.mime);
  const body = (text ?? '').trim();
  if (!body) {
    throw new ValidationError('Could not extract text from this file', [
      { field: 'file', reason: 'no extractable text' },
    ]);
  }

  // For TXT/MD, try the cheap section parser first. PDFs typically don't
  // have markdown-style headings, so go straight to AI for them.
  let sections: Partial<Record<keyof Behavior, string>> = {};
  let method: 'sections' | 'ai';
  if (!isPdf && !isDocx) {
    sections = splitBehaviorSections(body);
  }
  if (Object.keys(sections).length === 0) {
    sections = await aiExtractBehaviorFromText(body);
    method = 'ai';
  } else {
    method = 'sections';
  }

  if (Object.keys(sections).length === 0) {
    throw new ValidationError('No behavior content recognized', [
      {
        field: 'file',
        reason:
          'Could not find Pricing/Demo/Followup/Handoff content in this file. Try adding section markers or use a clearer PDF.',
      },
    ]);
  }

  const existing = (profile.behavior ?? {}) as Behavior;
  const merged: Behavior = { ...existing };
  const updated: Array<keyof Behavior> = [];
  for (const k of ['pricing', 'demo', 'followup', 'handoff'] as const) {
    const v = sections[k];
    if (v && v.trim()) {
      merged[k] = v.trim().slice(0, 2000);
      updated.push(k);
    }
  }
  const next = await update(workspaceId, profileId, { behavior: merged });
  return { profile: next, updatedFields: updated, method };
}

/** Back-compat alias — older callers passed extracted text directly. */
export async function importBehaviorFromText(
  workspaceId: string,
  profileId: string,
  text: string,
): Promise<{ profile: SalesTrainingProfile; updatedFields: Array<keyof Behavior> }> {
  const r = await importBehaviorFromFile(workspaceId, profileId, {
    fileName: 'inline.md',
    buffer: Buffer.from(text, 'utf-8'),
    mime: 'text/markdown',
  });
  return { profile: r.profile, updatedFields: r.updatedFields };
}

/**
 * Claude Sonnet pass for behavior — maps free-form text to the 4 fields when
 * the deterministic section parser can't find headings. Returns a partial:
 * fields the document doesn't address are omitted (leaving existing values
 * intact).
 */
async function aiExtractBehaviorFromText(
  text: string,
): Promise<Partial<Record<keyof Behavior, string>>> {
  const trimmed = text.length > 14000 ? text.slice(0, 14000) + '\n\n[…truncated]' : text;
  const anthropic = getAnthropic();
  const response = await anthropic.messages.create({
    model: env().ANTHROPIC_MODEL_HEAVY,
    max_tokens: 2000,
    system:
      'You map a sales-playbook document into four behavior fields. Output ONLY a JSON object — no prose, no code fences. Shape: {"pricing"?: string, "demo"?: string, "followup"?: string, "handoff"?: string}. Each string ≤2000 chars, describing what to do for that situation. OMIT any field the document does not address (do not invent content). If none of the fields are addressed, return {}.',
    messages: [
      {
        role: 'user',
        content: `Document:\n\n${trimmed}\n\n---\n\nReturn the JSON object now.`,
      },
    ],
  });
  const blocks = (response as { content: Array<{ type: string; text?: string }> }).content;
  const raw = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const obj = parsed as Record<string, unknown>;
  const out: Partial<Record<keyof Behavior, string>> = {};
  for (const k of ['pricing', 'demo', 'followup', 'handoff'] as const) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) {
      out[k] = v.trim().slice(0, 2000);
    }
  }
  return out;
}

/** Split a free-form behavior text into the 4 known sections. */
function splitBehaviorSections(body: string): Partial<Record<keyof Behavior, string>> {
  // Lines starting with #, ##, ### (markdown heading) OR uppercase/Sentence-case
  // section labels followed by colon — both treated as section boundaries.
  const re = /^(?:#{1,6}\s+|)([A-Za-z][A-Za-z\s/-]{1,40}?)[:\s]*$/gm;
  const lines = body.split(/\r?\n/);

  const sectionFor = (raw: string): keyof Behavior | null => {
    const k = raw.trim().toLowerCase().replace(/[_/-]+/g, ' ').replace(/\s+/g, ' ');
    if (/^pric(ing|e)/.test(k) || /pricing handling$/.test(k)) return 'pricing';
    if (/^demo/.test(k) || /demo handling$/.test(k)) return 'demo';
    if (/^follow.?up/.test(k) || /^followup/.test(k)) return 'followup';
    if (/^hand.?off/.test(k) || /^escalat/.test(k)) return 'handoff';
    return null;
  };

  const out: Partial<Record<keyof Behavior, string>> = {};
  let current: keyof Behavior | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current && buf.length > 0) {
      const content = buf.join('\n').trim();
      if (content) out[current] = content;
    }
    buf = [];
  };

  for (const rawLine of lines) {
    const headingMatch = rawLine.match(/^#{1,6}\s+(.+?)\s*$/);
    const colonMatch = rawLine.match(/^([A-Za-z][A-Za-z\s/-]{1,40}?)\s*:\s*$/);
    const label = headingMatch?.[1] ?? colonMatch?.[1] ?? null;
    if (label) {
      const next = sectionFor(label);
      if (next) {
        flush();
        current = next;
        continue;
      }
    }
    if (current) buf.push(rawLine);
  }
  flush();
  // Touch unused regex var for lint
  void re;
  return out;
}

function validateKnowledge(input: { title: string; content: string }): void {
  if (!input.title.trim() || input.title.trim().length > 120) {
    throw new ValidationError('Invalid title', [{ field: 'title', reason: '1-120 chars' }]);
  }
  if (input.content.length > KNOWLEDGE_CONTENT_MAX) {
    throw new ValidationError(`Content too long (max ${KNOWLEDGE_CONTENT_MAX} chars)`, [
      { field: 'content', reason: `max ${KNOWLEDGE_CONTENT_MAX} chars` },
    ]);
  }
}

// ─── Runtime read used by ai-context.service.ts ────────────────────────────
// Lean, cache-friendly runtime payload. The trained_summary IS the distilled
// product memory (generateSummary already folds FAQs + behavior + knowledge
// into it), so we deliberately do NOT ship raw FAQs or knowledge entries to
// the per-call AI context — that was the dominant token cost. Cross-sell is
// reduced to {slug, name} so the AI can mention adjacent products by name.
export interface RuntimeProductTraining {
  name: string;
  description: string | null;
  trainedSummary: string;
  behavior: Behavior;
  crossSellProfiles: Array<{ slug: string; name: string }>;
}

export async function getForRuntime(
  workspaceId: string,
  site: string,
  // Kept in the signature for caller compatibility — tag is no longer a
  // routing key for training data (one profile per product = one per site).
  // The tag still flows through the lead's custom_fields so AI prompts can
  // read it as channel signal.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _tag: string,
): Promise<RuntimeProductTraining | null> {
  const db = getDb();
  // Product-level profile match first (source_tag IS NULL). Falls back to
  // any legacy tag-level row for the same site if a product-level profile
  // hasn't been promoted yet — keeps the runtime working mid-migration.
  const rows = await db
    .select()
    .from(salesTrainingProfiles)
    .where(
      and(
        eq(salesTrainingProfiles.workspaceId, workspaceId),
        eq(salesTrainingProfiles.sourceSite, site),
        eq(salesTrainingProfiles.status, 'trained'),
      ),
    )
    .orderBy(
      // Postgres orders nulls last by default; flip so product-level wins.
      sql`${salesTrainingProfiles.sourceTag} IS NULL DESC`,
    )
    .limit(1);
  const profile = rows[0];
  if (!profile || !profile.trainedSummary) return null;
  // Operator pulled the kill switch — AI must not act on inbound leads for
  // this (site, tag). Returning null sends the runner down the
  // human_handoff path instead.
  if (profile.disabled) return null;

  // Resolve cross-sell slugs to {slug, name, trainedSummary?}. Dangling slugs
  // (profiles since deleted/renamed) silently drop out.
  const crossSlugs = (profile.crossSell ?? []) as string[];
  const xs: RuntimeProductTraining['crossSellProfiles'] = [];
  if (crossSlugs.length > 0) {
    const adj = await db
      .select({
        slug: salesTrainingProfiles.slug,
        name: salesTrainingProfiles.name,
      })
      .from(salesTrainingProfiles)
      .where(
        and(
          eq(salesTrainingProfiles.workspaceId, workspaceId),
          inArray(salesTrainingProfiles.slug, crossSlugs),
        ),
      );
    const adjMap = new Map(adj.map((a) => [a.slug, a]));
    for (const slug of crossSlugs) {
      const a = adjMap.get(slug);
      if (a) xs.push({ slug: a.slug, name: a.name });
    }
  }

  // NOTE: raw FAQs + knowledge entries are intentionally NOT loaded here — the
  // trained_summary already encodes them. This keeps the per-call AI context
  // small (the single biggest token saving). Regenerate the summary if the AI
  // needs more product detail.
  return {
    name: profile.name,
    description: profile.description,
    trainedSummary: profile.trainedSummary,
    behavior: (profile.behavior ?? {}) as Behavior,
    crossSellProfiles: xs,
  };
}

// ─── Internal helpers ──────────────────────────────────────────────────────
async function fetchProfile(workspaceId: string, profileId: string): Promise<SalesTrainingProfile> {
  const db = getDb();
  const rows = await db
    .select()
    .from(salesTrainingProfiles)
    .where(
      and(
        eq(salesTrainingProfiles.id, profileId),
        eq(salesTrainingProfiles.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new NotFoundError('Training profile not found');
  return rows[0];
}
