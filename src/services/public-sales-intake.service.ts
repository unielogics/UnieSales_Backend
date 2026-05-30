import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { INTAKE_WORKSPACE_ID } from '../config/intake-routing';
import { leads, type NewLead } from '../db/schema/leads';
import * as activity from './sales-activity.service';
import * as notes from './sales-note.service';
import * as tasks from './sales-task.service';

export interface CatalogAuditSalesIntakeInput {
  tag: 'website_catalog_audit';
  page_url: string;
  contact: {
    contactName?: string;
    email: string;
    phone?: string;
    company?: string;
    title?: string;
  };
  fields?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface CatalogAuditSalesIntakeResult {
  lead_id: string;
  status: 'created' | 'existing';
}

const SOURCE = 'unieconnect_catalog_audit';

export async function submitCatalogAuditSalesIntake(
  body: CatalogAuditSalesIntakeInput,
): Promise<CatalogAuditSalesIntakeResult> {
  const db = getDb();
  const fields = body.fields ?? {};
  const meta = body.meta ?? {};
  const reference = stringOrNull(meta.cortex_reference) || stringOrNull(fields.reference);
  const email = body.contact.email.trim().toLowerCase();

  if (reference) {
    const existing = (
      await db
        .select({ id: leads.id })
        .from(leads)
        .where(
          and(
            eq(leads.workspaceId, INTAKE_WORKSPACE_ID),
            eq(leads.source, SOURCE),
            sql`${leads.customFields}->'meta'->>'cortex_reference' = ${reference}`,
          ),
        )
        .limit(1)
    )[0];
    if (existing) return { lead_id: existing.id, status: 'existing' };
  }

  const contactName =
    body.contact.contactName?.trim() ||
    stringOrNull(fields.company) ||
    body.contact.company?.trim() ||
    email;
  const website = stringOrNull(fields.website) || body.page_url;
  const companyName = stringOrNull(fields.company) || body.contact.company?.trim() || null;
  const confidence = numberOrNull(fields.confidence);
  const productCount = numberOrNull(fields.product_count);
  const customFields = {
    site: 'unieconnect',
    tag: body.tag,
    page_url: body.page_url,
    contact: body.contact,
    fields,
    meta,
    flat: flatten(fields),
  } as unknown as Record<string, string>;

  const insertValues: NewLead = {
    workspaceId: INTAKE_WORKSPACE_ID,
    campaignId: null,
    email,
    contactName,
    firstName: null,
    lastName: null,
    phone: body.contact.phone?.trim() || null,
    companyName,
    title: body.contact.title?.trim() || null,
    website,
    source: SOURCE,
    sourceUrl: body.page_url,
    sourceNotes: reference ? `Cortex fulfillment snapshot ${reference}` : 'Cortex fulfillment snapshot',
    customFields,
    leadScore: confidence ?? 0,
    leadScoreReason: confidence == null ? null : `Public catalog audit confidence ${confidence}/100`,
    status: 'pending_review',
    pipelineStage: 'new_catalog_audit',
    importOrigin: 'intake',
  };

  const [lead] = await db.insert(leads).values(insertValues).returning({ id: leads.id });
  if (!lead) throw new Error('catalogAuditSalesIntake: insert returned no row');

  await activity.emit({
    workspaceId: INTAKE_WORKSPACE_ID,
    leadId: lead.id,
    campaignId: null,
    activityType: 'intake_received',
    title: reference ? `UnieConnect CAT audit ${reference}` : 'UnieConnect catalog audit',
    description: `${companyName || contactName} submitted a public fulfillment snapshot.`,
    metadata: {
      source: SOURCE,
      cortex_reference: reference,
      website,
      product_count: productCount,
      confidence,
    },
    createdBy: 'system',
  });

  await notes.create({
    workspaceId: INTAKE_WORKSPACE_ID,
    leadId: lead.id,
    kind: 'intake_summary',
    title: reference ? `Catalog audit summary · ${reference}` : 'Catalog audit summary',
    body: buildSummary(body, reference),
  });

  await tasks.create({
    workspaceId: INTAKE_WORKSPACE_ID,
    leadId: lead.id,
    title: reference ? `Review UnieConnect CAT audit lead · ${reference}` : 'Review UnieConnect CAT audit lead',
    type: 'review_form_submission',
    priority: confidence != null && confidence >= 70 ? 'high' : 'med',
    source: 'AI',
  });

  return { lead_id: lead.id, status: 'created' };
}

function buildSummary(body: CatalogAuditSalesIntakeInput, reference: string | null): string {
  const fields = body.fields ?? {};
  const network = asRecord(fields.network_comparison);
  const projection = asRecord(fields.monthly_projection);
  const blockers = Array.isArray(fields.blockers) ? fields.blockers.map(String) : [];
  const actions = Array.isArray(fields.next_actions) ? fields.next_actions.map(String) : [];
  const savings = numberOrNull(network.estimated_monthly_savings);
  const lines = [
    reference ? `Reference: ${reference}` : null,
    `Website: ${stringOrNull(fields.website) || body.page_url}`,
    `Company: ${stringOrNull(fields.company) || body.contact.company || 'Unknown'}`,
    `Products discovered: ${numberOrNull(fields.product_count) ?? 'unknown'}`,
    `Confidence: ${numberOrNull(fields.confidence) ?? 'unknown'}/100`,
    savings == null ? null : `Modeled monthly savings: $${savings.toLocaleString()}`,
    projection.base == null ? null : `Modeled monthly base cost: $${Number(projection.base).toLocaleString()}`,
    blockers.length ? `Blockers: ${blockers.slice(0, 5).join('; ')}` : 'Blockers: none reported',
    actions.length ? `Next actions: ${actions.slice(0, 5).join('; ')}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function flatten(fields: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (obj: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(obj)) {
      if (value == null || value === '') continue;
      const next = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        out[next] = String(value);
      } else if (Array.isArray(value) && value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) {
        out[next] = value.map(String).join(', ');
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        visit(value as Record<string, unknown>, next);
      }
    }
  };
  visit(fields, '');
  return out;
}
