import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { aiActions } from '../db/schema/ai-actions';
import { campaigns } from '../db/schema/campaigns';
import { costEvents, costRateCards, type CostSource, type NewCostEvent } from '../db/schema/cost-events';
import { emailMessages } from '../db/schema/email-messages';
import { leads } from '../db/schema/leads';
import { salesTrainingMessages, salesTrainingProfiles } from '../db/schema/sales-training';

export type CostCategory = 'ai' | 'messaging' | 'storage' | 'file' | 'automation' | 'api';

export interface CostFilters {
  from?: Date;
  to?: Date;
  campaignId?: string;
  leadId?: string;
  provider?: string;
  category?: string;
  costSource?: CostSource;
}

export interface CostEventInput {
  workspaceId: string;
  campaignId?: string | null;
  leadId?: string | null;
  emailThreadId?: string | null;
  emailMessageId?: string | null;
  aiActionId?: string | null;
  sourceObjectType?: string | null;
  sourceObjectId?: string | null;
  dedupeKey: string;
  provider: string;
  service: string;
  category: CostCategory | string;
  actionType?: string | null;
  channel?: string | null;
  quantity: number;
  unit: string;
  unitCostUsd?: number;
  amountUsd?: number;
  currency?: string;
  pricingVersion?: string;
  costSource?: CostSource;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}

export const DEFAULT_RATE_CARDS = [
  // Anthropic defaults are intentionally editable estimates. Stored per event
  // at write-time so later rate changes do not mutate historical usage.
  { provider: 'anthropic', service: 'claude-haiku-4-5', category: 'ai', actionType: 'input', unit: '1k_tokens', unitCostUsd: 0.0008 },
  { provider: 'anthropic', service: 'claude-haiku-4-5', category: 'ai', actionType: 'output', unit: '1k_tokens', unitCostUsd: 0.004 },
  { provider: 'anthropic', service: 'claude-haiku-4-5', category: 'ai', actionType: 'cache_read', unit: '1k_tokens', unitCostUsd: 0.00008 },
  { provider: 'anthropic', service: 'claude-haiku-4-5', category: 'ai', actionType: 'cache_creation', unit: '1k_tokens', unitCostUsd: 0.001 },
  { provider: 'anthropic', service: 'claude-sonnet-4-6', category: 'ai', actionType: 'input', unit: '1k_tokens', unitCostUsd: 0.003 },
  { provider: 'anthropic', service: 'claude-sonnet-4-6', category: 'ai', actionType: 'output', unit: '1k_tokens', unitCostUsd: 0.015 },
  { provider: 'anthropic', service: 'claude-sonnet-4-6', category: 'ai', actionType: 'cache_read', unit: '1k_tokens', unitCostUsd: 0.0003 },
  { provider: 'anthropic', service: 'claude-sonnet-4-6', category: 'ai', actionType: 'cache_creation', unit: '1k_tokens', unitCostUsd: 0.00375 },
  { provider: 'gmail', service: 'gmail_api', category: 'messaging', actionType: 'send_email', unit: 'message', unitCostUsd: 0 },
  { provider: 'gmail', service: 'gmail_api', category: 'messaging', actionType: 'create_draft', unit: 'message', unitCostUsd: 0 },
  { provider: 'gmail', service: 'gmail_api', category: 'api', actionType: 'sync_message', unit: 'message', unitCostUsd: 0 },
  { provider: 'twilio', service: 'sms', category: 'messaging', actionType: 'sms_segment', unit: 'segment', unitCostUsd: 0.0079 },
  { provider: 'aws', service: 's3', category: 'storage', actionType: 'put_object', unit: 'request', unitCostUsd: 0.000005 },
  { provider: 'aws', service: 's3', category: 'storage', actionType: 'storage_gb_month_estimate', unit: 'gb_month', unitCostUsd: 0.023 },
] as const;

type RateLookup = (typeof DEFAULT_RATE_CARDS)[number];

function n(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function money(value: number): string {
  return value.toFixed(9);
}

function rateFor(input: Pick<CostEventInput, 'provider' | 'service' | 'category' | 'actionType' | 'unit'>): RateLookup | null {
  return (
    DEFAULT_RATE_CARDS.find(
      (r) =>
        r.provider === input.provider &&
        r.service === input.service &&
        r.category === input.category &&
        r.actionType === input.actionType &&
        r.unit === input.unit,
    ) ?? null
  );
}

export async function recordCostEvent(input: CostEventInput): Promise<void> {
  const rate = input.unitCostUsd == null ? rateFor(input) : null;
  const unitCost = input.unitCostUsd ?? rate?.unitCostUsd ?? 0;
  const amount = input.amountUsd ?? input.quantity * unitCost;
  const db = getDb();
  await db
    .insert(costEvents)
    .values({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId ?? null,
      leadId: input.leadId ?? null,
      emailThreadId: input.emailThreadId ?? null,
      emailMessageId: input.emailMessageId ?? null,
      aiActionId: input.aiActionId ?? null,
      sourceObjectType: input.sourceObjectType ?? null,
      sourceObjectId: input.sourceObjectId ?? null,
      dedupeKey: input.dedupeKey,
      provider: input.provider,
      service: input.service,
      category: input.category,
      actionType: input.actionType ?? null,
      channel: input.channel ?? null,
      quantity: String(input.quantity),
      unit: input.unit,
      unitCostUsd: money(unitCost),
      amountUsd: money(amount),
      currency: input.currency ?? 'USD',
      pricingVersion: input.pricingVersion ?? 'default',
      costSource: input.costSource ?? 'estimated',
      occurredAt: input.occurredAt ?? new Date(),
      metadata: input.metadata ?? {},
    } as NewCostEvent)
    .onConflictDoNothing({ target: costEvents.dedupeKey });
}

export async function recordAiTokenCosts(input: {
  workspaceId: string;
  campaignId?: string | null;
  leadId?: string | null;
  emailThreadId?: string | null;
  aiActionId?: string | null;
  sourceObjectType?: string | null;
  sourceObjectId?: string | null;
  dedupePrefix?: string;
  actionType?: string | null;
  service: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  occurredAt?: Date;
  costSource?: CostSource;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const rows: Array<[string, number | null | undefined]> = [
    ['input', input.inputTokens],
    ['output', input.outputTokens],
    ['cache_read', input.cacheReadTokens],
    ['cache_creation', input.cacheCreationTokens],
  ];
  for (const [tokenType, tokens] of rows) {
    const quantity = n(tokens) / 1000;
    if (quantity <= 0) continue;
    const sourceObjectType = input.sourceObjectType ?? (input.aiActionId ? 'ai_action' : 'ai_usage');
    const sourceObjectId = input.sourceObjectId ?? input.aiActionId ?? `${input.workspaceId}:${input.actionType ?? 'unknown'}:${input.occurredAt?.toISOString() ?? 'unknown'}`;
    const dedupePrefix = input.dedupePrefix ?? (input.aiActionId ? 'ai' : sourceObjectType);
    await recordCostEvent({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      leadId: input.leadId,
      emailThreadId: input.emailThreadId,
      aiActionId: input.aiActionId ?? null,
      sourceObjectType,
      sourceObjectId,
      dedupeKey: `${dedupePrefix}:${sourceObjectId}:${tokenType}`,
      provider: 'anthropic',
      service: input.service,
      category: 'ai',
      actionType: tokenType,
      channel: null,
      quantity,
      unit: '1k_tokens',
      costSource: input.costSource ?? 'estimated',
      occurredAt: input.occurredAt,
      metadata: { ...(input.metadata ?? {}), aiActionType: input.actionType, tokens: n(tokens), tokenType },
    });
  }
}

export async function seedDefaultRates(workspaceId?: string): Promise<void> {
  const db = getDb();
  for (const r of DEFAULT_RATE_CARDS) {
    const [existing] = await db
      .select({ id: costRateCards.id })
      .from(costRateCards)
      .where(
        and(
          workspaceId == null ? sql`${costRateCards.workspaceId} IS NULL` : eq(costRateCards.workspaceId, workspaceId),
          eq(costRateCards.provider, r.provider),
          eq(costRateCards.service, r.service),
          eq(costRateCards.category, r.category),
          eq(costRateCards.actionType, r.actionType),
          eq(costRateCards.unit, r.unit),
          eq(costRateCards.pricingVersion, 'default'),
        ),
      )
      .limit(1);
    if (existing) continue;
    await db
      .insert(costRateCards)
      .values({
        workspaceId: workspaceId ?? null,
        provider: r.provider,
        service: r.service,
        category: r.category,
        actionType: r.actionType,
        unit: r.unit,
        unitCostUsd: money(r.unitCostUsd),
        pricingVersion: 'default',
      })
      .onConflictDoNothing();
  }
}

export async function listRates(workspaceId: string) {
  await seedDefaultRates();
  const db = getDb();
  return db
    .select()
    .from(costRateCards)
    .where(sql`${costRateCards.workspaceId} IS NULL OR ${costRateCards.workspaceId} = ${workspaceId}`)
    .orderBy(costRateCards.provider, costRateCards.service, costRateCards.category, costRateCards.actionType);
}

export async function updateRate(
  workspaceId: string,
  patch: {
    provider: string;
    service: string;
    category: string;
    actionType?: string | null;
    unit: string;
    unitCostUsd: number;
  },
) {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(costRateCards)
    .where(
      and(
        eq(costRateCards.workspaceId, workspaceId),
        eq(costRateCards.provider, patch.provider),
        eq(costRateCards.service, patch.service),
        eq(costRateCards.category, patch.category),
        patch.actionType == null ? sql`${costRateCards.actionType} IS NULL` : eq(costRateCards.actionType, patch.actionType),
        eq(costRateCards.unit, patch.unit),
      ),
    )
    .limit(1);
  if (existing) {
    const [updated] = await db
      .update(costRateCards)
      .set({ unitCostUsd: money(patch.unitCostUsd), updatedAt: new Date() })
      .where(eq(costRateCards.id, existing.id))
      .returning();
    return updated!;
  }
  const [created] = await db
    .insert(costRateCards)
    .values({
      workspaceId,
      provider: patch.provider,
      service: patch.service,
      category: patch.category,
      actionType: patch.actionType ?? null,
      unit: patch.unit,
      unitCostUsd: money(patch.unitCostUsd),
    })
    .returning();
  return created!;
}

function filterSql(workspaceId: string, filters: CostFilters = {}) {
  const conds = [sql`ce.workspace_id = ${workspaceId}`];
  if (filters.from) conds.push(sql`ce.occurred_at >= ${filters.from}`);
  if (filters.to) conds.push(sql`ce.occurred_at <= ${filters.to}`);
  if (filters.campaignId) conds.push(sql`ce.campaign_id = ${filters.campaignId}`);
  if (filters.leadId) conds.push(sql`ce.lead_id = ${filters.leadId}`);
  if (filters.provider) conds.push(sql`ce.provider = ${filters.provider}`);
  if (filters.category) conds.push(sql`ce.category = ${filters.category}`);
  if (filters.costSource) conds.push(sql`ce.cost_source = ${filters.costSource}`);
  return sql.join(conds, sql` AND `);
}

export async function backfillWorkspaceCosts(workspaceId: string): Promise<{ inserted: number }> {
  const before = await countEvents(workspaceId);
  const db = getDb();
  const aiRows = await db
    .select()
    .from(aiActions)
    .where(eq(aiActions.workspaceId, workspaceId));
  for (const a of aiRows) {
    await recordAiTokenCosts({
      workspaceId: a.workspaceId,
      campaignId: a.campaignId,
      leadId: a.leadId,
      emailThreadId: a.emailThreadId,
      aiActionId: a.id,
      actionType: a.actionType,
      service: serviceForAiAction(a.actionType ?? '', {
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
      }),
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      cacheReadTokens: a.cacheReadTokens,
      cacheCreationTokens: a.cacheCreationTokens,
      occurredAt: a.completedAt ?? a.createdAt,
      costSource: 'estimated',
    });
  }

  const trainingRows = await db
    .select({
      msg: salesTrainingMessages,
      profile: salesTrainingProfiles,
    })
    .from(salesTrainingMessages)
    .innerJoin(salesTrainingProfiles, eq(salesTrainingMessages.profileId, salesTrainingProfiles.id))
    .where(eq(salesTrainingProfiles.workspaceId, workspaceId));
  for (const row of trainingRows) {
    await recordAiTokenCosts({
      workspaceId,
      sourceObjectType: 'sales_training_message',
      sourceObjectId: row.msg.id,
      dedupePrefix: 'sales_training',
      actionType: 'sales_training_message',
      service: 'claude-sonnet-4-6',
      inputTokens: row.msg.inputTokens,
      outputTokens: row.msg.outputTokens,
      occurredAt: row.msg.createdAt,
      costSource: 'estimated',
    });
  }

  const messageRows = await db
    .select()
    .from(emailMessages)
    .where(eq(emailMessages.workspaceId, workspaceId));
  for (const m of messageRows) {
    if (m.channel === 'sms') {
      const segments = smsSegments(m.body ?? '');
      await recordCostEvent({
        workspaceId,
        campaignId: m.campaignId,
        leadId: m.leadId,
        emailThreadId: m.emailThreadId,
        emailMessageId: m.id,
        sourceObjectType: 'email_message',
        sourceObjectId: m.id,
        dedupeKey: `message:${m.id}:sms_segment`,
        provider: 'twilio',
        service: 'sms',
        category: 'messaging',
        actionType: 'sms_segment',
        channel: 'sms',
        quantity: segments,
        unit: 'segment',
        costSource: 'estimated',
        occurredAt: m.createdAt,
        metadata: { direction: m.direction, twilioMessageSid: m.twilioMessageSid },
      });
    } else if (m.direction === 'outbound' || m.direction === 'draft') {
      const actionType = m.direction === 'draft' ? 'create_draft' : 'send_email';
      await recordCostEvent({
        workspaceId,
        campaignId: m.campaignId,
        leadId: m.leadId,
        emailThreadId: m.emailThreadId,
        emailMessageId: m.id,
        sourceObjectType: 'email_message',
        sourceObjectId: m.id,
        dedupeKey: `message:${m.id}:${actionType}`,
        provider: 'gmail',
        service: 'gmail_api',
        category: 'messaging',
        actionType,
        channel: 'email',
        quantity: 1,
        unit: 'message',
        costSource: 'estimated',
        occurredAt: m.createdAt,
        metadata: { direction: m.direction, gmailMessageId: m.gmailMessageId },
      });
    } else if (m.channel === 'email') {
      await recordCostEvent({
        workspaceId,
        campaignId: m.campaignId,
        leadId: m.leadId,
        emailThreadId: m.emailThreadId,
        emailMessageId: m.id,
        sourceObjectType: 'email_message',
        sourceObjectId: m.id,
        dedupeKey: `message:${m.id}:sync_message`,
        provider: 'gmail',
        service: 'gmail_api',
        category: 'api',
        actionType: 'sync_message',
        channel: 'email',
        quantity: 1,
        unit: 'message',
        costSource: 'estimated',
        occurredAt: m.createdAt,
        metadata: { direction: m.direction, gmailMessageId: m.gmailMessageId },
      });
    }
  }

  const after = await countEvents(workspaceId);
  return { inserted: Math.max(0, after - before) };
}

function serviceForAiAction(actionType: string, usage: { inputTokens?: number | null; outputTokens?: number | null }): string {
  if (/playbook|demo|training|knowledge|summarize/i.test(actionType)) return 'claude-sonnet-4-6';
  if (n(usage.inputTokens) + n(usage.outputTokens) > 6000) return 'claude-sonnet-4-6';
  return 'claude-haiku-4-5';
}

function smsSegments(body: string): number {
  if (!body) return 1;
  return Math.max(1, Math.ceil(body.length / 160));
}

async function countEvents(workspaceId: string): Promise<number> {
  const db = getDb();
  const result = await db.execute(sql`select count(*)::int as count from cost_events where workspace_id = ${workspaceId}`);
  return n(result.rows[0]?.count);
}

export async function getSummary(workspaceId: string, filters: CostFilters = {}) {
  const db = getDb();
  const where = filterSql(workspaceId, filters);
  const [totals, byProvider, byCategory, byDay, topCampaigns, topLeads] = await Promise.all([
    db.execute(sql`
      select
        coalesce(sum(amount_usd), 0)::float8 as total,
        coalesce(sum(case when cost_source = 'exact' then amount_usd else 0 end), 0)::float8 as exact,
        coalesce(sum(case when cost_source <> 'exact' then amount_usd else 0 end), 0)::float8 as estimated,
        count(*)::int as events,
        count(distinct campaign_id)::int as campaigns,
        count(distinct lead_id)::int as leads
      from cost_events ce
      where ${where}
    `),
    db.execute(sql`
      select provider, service, coalesce(sum(amount_usd), 0)::float8 as amount, count(*)::int as events
      from cost_events ce
      where ${where}
      group by provider, service
      order by amount desc
    `),
    db.execute(sql`
      select category, coalesce(sum(amount_usd), 0)::float8 as amount, count(*)::int as events
      from cost_events ce
      where ${where}
      group by category
      order by amount desc
    `),
    db.execute(sql`
      select date_trunc('day', occurred_at)::date::text as day, coalesce(sum(amount_usd), 0)::float8 as amount
      from cost_events ce
      where ${where}
      group by 1
      order by 1
    `),
    db.execute(sql`
      select c.id, coalesce(c.name, '(no campaign)') as name, coalesce(sum(ce.amount_usd), 0)::float8 as amount,
             count(distinct ce.lead_id)::int as leads, count(*)::int as events
      from cost_events ce
      left join campaigns c on c.id = ce.campaign_id
      where ${where}
      group by c.id, c.name
      order by amount desc
      limit 20
    `),
    db.execute(sql`
      select l.id, coalesce(l.contact_name, l.email, l.company_name, '(no lead)') as name,
             l.email, l.company_name as company, coalesce(sum(ce.amount_usd), 0)::float8 as amount,
             count(*)::int as events
      from cost_events ce
      left join leads l on l.id = ce.lead_id
      where ${where}
      group by l.id, l.contact_name, l.email, l.company_name
      order by amount desc
      limit 20
    `),
  ]);
  const t = totals.rows[0] ?? {};
  const total = n(t.total);
  const events = n(t.events);
  const days = Math.max(1, daysBetween(filters.from, filters.to));
  return {
    totals: {
      total,
      exact: n(t.exact),
      estimated: n(t.estimated),
      events,
      campaigns: n(t.campaigns),
      leads: n(t.leads),
      projectedMonthly: (total / days) * 30,
      estimatedShare: total > 0 ? n(t.estimated) / total : 0,
    },
    byProvider: byProvider.rows,
    byCategory: byCategory.rows,
    byDay: byDay.rows,
    topCampaigns: topCampaigns.rows,
    topLeads: topLeads.rows,
  };
}

export async function getCampaignCosts(workspaceId: string, filters: CostFilters = {}) {
  const db = getDb();
  const where = filterSql(workspaceId, filters);
  const result = await db.execute(sql`
    select
      c.id,
      coalesce(c.name, '(no campaign)') as name,
      c.status,
      coalesce(sum(ce.amount_usd), 0)::float8 as amount,
      coalesce(sum(case when ce.category = 'ai' then ce.amount_usd else 0 end), 0)::float8 as ai,
      coalesce(sum(case when ce.category = 'messaging' then ce.amount_usd else 0 end), 0)::float8 as messaging,
      coalesce(sum(case when ce.category in ('storage','file') then ce.amount_usd else 0 end), 0)::float8 as files,
      count(distinct ce.lead_id)::int as leads_touched,
      count(distinct case when em.direction = 'outbound' then em.id end)::int as sends,
      count(distinct case when em.direction = 'inbound' then em.id end)::int as replies,
      count(*)::int as events
    from cost_events ce
    left join campaigns c on c.id = ce.campaign_id
    left join email_messages em on em.id = ce.email_message_id
    where ${where}
    group by c.id, c.name, c.status
    order by amount desc
  `);
  return result.rows;
}

export async function getLeadCosts(workspaceId: string, filters: CostFilters = {}) {
  const db = getDb();
  const where = filterSql(workspaceId, filters);
  const result = await db.execute(sql`
    select
      l.id,
      coalesce(l.contact_name, l.email, l.company_name, '(no lead)') as name,
      l.email,
      l.company_name as company,
      l.status,
      l.import_origin as origin,
      coalesce(sum(ce.amount_usd), 0)::float8 as amount,
      coalesce(sum(case when ce.category = 'ai' then ce.amount_usd else 0 end), 0)::float8 as ai,
      coalesce(sum(case when ce.category = 'messaging' then ce.amount_usd else 0 end), 0)::float8 as messaging,
      count(*)::int as events,
      count(distinct ce.campaign_id)::int as campaigns
    from cost_events ce
    left join leads l on l.id = ce.lead_id
    where ${where}
    group by l.id, l.contact_name, l.email, l.company_name, l.status, l.import_origin
    order by amount desc
    limit 250
  `);
  return result.rows;
}

export async function listEvents(workspaceId: string, filters: CostFilters & { limit?: number; offset?: number } = {}) {
  const db = getDb();
  const where = filterSql(workspaceId, filters);
  const result = await db.execute(sql`
    select
      ce.*,
      c.name as campaign_name,
      coalesce(l.contact_name, l.email, l.company_name) as lead_name,
      l.email as lead_email
    from cost_events ce
    left join campaigns c on c.id = ce.campaign_id
    left join leads l on l.id = ce.lead_id
    where ${where}
    order by ce.occurred_at desc, ce.created_at desc
    limit ${Math.min(filters.limit ?? 100, 500)}
    offset ${filters.offset ?? 0}
  `);
  return result.rows;
}

function daysBetween(from?: Date, to?: Date): number {
  if (!from && !to) return 30;
  const start = from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = to ?? new Date();
  return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
}
