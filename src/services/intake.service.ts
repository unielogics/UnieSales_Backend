/**
 * Public-intake service. Receives validated form submissions from the three
 * site-scoped POST endpoints (uniewms, unielogics, uniecortex) and persists
 * them as `leads` rows in the Inbound workspace.
 *
 * Wire contract (per route):
 *   POST /api/public/intake/<site>
 *   body: { tag, page_url, contact, fields, meta, hp_email? }
 *
 * The destination columns + custom_fields shape are documented in the plan
 * (Layer 1). Critically: `customFields` keeps a fixed top-level shape with
 * protected keys (site, tag, page_url, contact, fields, meta) plus a `flat`
 * convenience namespace for AI prompts. The raw form payload arrives in
 * `body.fields` and is rejected if it tries to overwrite any protected key.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { leads, type NewLead } from '../db/schema/leads';
import { env } from '../config/env';
import { ValidationError, ConflictError } from '../utils/errors';
import * as suppression from './suppression.service';
import { lookupRouting, type IntakeSite } from '../config/intake-routing';
import { splitName } from './util/name-splitter';
import * as postIntakeRunner from './post-intake-runner.service';
import * as activity from './sales-activity.service';

// Top-level envelope keys that form payloads MUST NOT overwrite. If a form's
// `fields` object contains any of these as a key, we reject the submission —
// otherwise an attacker (or a careless form author) could route a payload to
// the wrong campaign or impersonate the contact block.
const PROTECTED_KEYS = ['site', 'tag', 'page_url', 'contact', 'fields', 'meta', 'flat'] as const;

export interface IntakeContact {
  contactName?: string;
  email: string;
  phone?: string;
  company?: string;
  title?: string;
  city?: string;
  state?: string;
}

export interface IntakeSubmitInput {
  site: IntakeSite;
  body: {
    tag: string;
    page_url: string;
    contact: IntakeContact;
    fields?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  };
  clientIp?: string;
  userAgent?: string;
}

export interface IntakeSubmitResult {
  lead_id: string;
}

// Per-route Zod hands us validated bodies, so we don't re-validate here.
// We do still check protected-key collisions on `fields` because that's a
// data shape rule the routes don't enforce.
function assertNoProtectedCollisions(fields: Record<string, unknown> | undefined): void {
  if (!fields) return;
  const collisions: string[] = [];
  for (const k of Object.keys(fields)) {
    if ((PROTECTED_KEYS as readonly string[]).includes(k)) collisions.push(k);
  }
  if (collisions.length > 0) {
    throw new ValidationError(
      `Reserved keys in fields: ${collisions.join(', ')}`,
      collisions.map((k) => ({ field: `fields.${k}`, reason: 'reserved by intake envelope' })),
    );
  }
}

/**
 * Flatten a small subset of well-known nested shapes (UnieLogics audit forms
 * nest under fields.identity / .common / .answers; UnieCortex nests under
 * .contact / .volume). Pulls scalar leaves into a flat record the AI can use
 * for greetings + personalization. Non-scalar values are skipped — the AI can
 * still see them via the `fields` blob.
 */
function flattenForAi(fields: Record<string, unknown> | undefined): Record<string, string> {
  if (!fields) return {};
  const out: Record<string, string> = {};
  const visit = (obj: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(obj)) {
      if (v == null || v === '') continue;
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out[key] = String(v);
      } else if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) {
        out[key] = v.map(String).join(', ');
      } else if (typeof v === 'object' && !Array.isArray(v)) {
        visit(v as Record<string, unknown>, key);
      }
      // arrays of objects + null + functions: skipped
    }
  };
  visit(fields, '');
  return out;
}

/**
 * Persist a validated public-intake submission as a lead. Throws:
 *  - ValidationError (400) — bad routing, protected-key collision, suppressed email
 *  - ConflictError (409)   — duplicate (already a lead for this workspace+email+campaign)
 */
export async function submit(input: IntakeSubmitInput): Promise<IntakeSubmitResult> {
  const { site, body } = input;

  // 1. Resolve routing. The Zod enums on the routes guarantee a known tag, so
  //    a miss here means seed/config drift — we want to fail loudly.
  const routing = lookupRouting(site, body.tag);
  if (!routing) {
    throw new ValidationError('No campaign configured for this form', [
      { field: 'tag', reason: `unknown site/tag combination: ${site}/${body.tag}` },
    ]);
  }
  const { workspaceId, campaignId } = routing;

  // 2. Reject form-supplied collisions on protected envelope keys.
  assertNoProtectedCollisions(body.fields);

  // 3. Suppression check — if this email was previously bounced or unsubscribed,
  //    record nothing and signal a soft success to the caller (treat as 409).
  const emailLower = body.contact.email.trim().toLowerCase();
  if (await suppression.isSuppressed(workspaceId, emailLower)) {
    throw new ConflictError('Email on suppression list', [
      { field: 'contact.email', reason: 'suppressed (bounced or opted out)' },
    ]);
  }

  // 4. Name splitting. Forms that already send first/last separately can pass
  //    them inside `fields` — we honour those when present; otherwise we split.
  const fieldsObj = (body.fields ?? {}) as Record<string, unknown>;
  const explicitFirst = stringOrNull(fieldsObj['firstName'] ?? fieldsObj['first_name'] ?? null);
  const explicitLast = stringOrNull(fieldsObj['lastName'] ?? fieldsObj['last_name'] ?? null);
  const fromSplit = splitName(body.contact.contactName);
  const firstName = explicitFirst ?? fromSplit.first;
  const lastName = explicitLast ?? fromSplit.last;
  // contactName canonical: prefer the explicit string the form sent; otherwise
  // reassemble from first/last so all three columns are consistent.
  const contactName =
    body.contact.contactName?.trim() ||
    [firstName, lastName].filter(Boolean).join(' ').trim() ||
    null;

  // 5. Compose the custom_fields envelope. Protected top-level keys come from
  //    the validated envelope; `flat` is our AI convenience namespace.
  const customFields = {
    site,
    tag: body.tag,
    page_url: body.page_url,
    contact: body.contact,
    fields: body.fields ?? {},
    meta: body.meta ?? {},
    flat: flattenForAi(body.fields),
  } as unknown as Record<string, string>;
  // The leads.customFields drizzle type is Record<string,string>; we store
  // a richer nested object — Postgres jsonb accepts it. The cast is safe.

  // 6. Insert the lead. The DB's partial unique index on (workspace, lower(email),
  //    campaign) raises 23505 if a duplicate exists → translate to 409.
  const db = getDb();
  const sourceTag = `${site}_${body.tag}`;
  const insertValues: NewLead = {
    workspaceId,
    campaignId,
    email: emailLower,
    contactName,
    firstName,
    lastName,
    phone: body.contact.phone?.trim() || null,
    companyName: body.contact.company?.trim() || null,
    title: body.contact.title?.trim() || null,
    city: body.contact.city?.trim() || null,
    state: body.contact.state?.trim() || null,
    source: sourceTag,
    sourceUrl: body.page_url,
    sourceNotes: stringOrNull(fieldsObj['notes']),
    customFields,
    status: 'pending_review',
    importOrigin: 'intake',
  };

  let row;
  try {
    [row] = await db.insert(leads).values(insertValues).returning({ id: leads.id });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new ConflictError('Lead already exists for this campaign', [
        { field: 'email', reason: 'duplicate (workspace + email + campaign)' },
      ]);
    }
    throw err;
  }
  if (!row) throw new Error('Insert returned no row');

  // Layer-2 hook: log the intake event + fire-and-forget the post-intake
  // triage runner. The public POST returns immediately; the runner does its
  // work asynchronously. Failures here MUST NOT propagate — the lead is
  // already persisted, and the runner has its own retry / lock semantics.
  void (async () => {
    try {
      await activity.emit({
        workspaceId,
        leadId: row.id,
        campaignId,
        activityType: 'intake_received',
        title: `Form: ${sourceTag}`,
        description: `From ${body.page_url}`,
        metadata: { site, tag: body.tag, page_url: body.page_url },
        createdBy: 'system',
      });
    } catch {
      /* swallow — activity is best-effort */
    }
    try {
      await postIntakeRunner.run({ workspaceId, leadId: row.id, campaignId });
    } catch (err) {
      // Log only — never throw out of the fire-and-forget chain. The lock
      // table will reflect a 'failed' status so operators can retry.
      // eslint-disable-next-line no-console
      console.warn(`post-intake-runner failed for lead ${row.id}:`, err);
    }
  })();

  return { lead_id: row.id };
}

function stringOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/**
 * HMAC verification for the server-to-server uniecortex endpoint. Compares
 * the provided `sha256=<hex>` header against HMAC(rawBody, sharedSecret)
 * using timing-safe equality. Returns false on any error.
 */
export function verifyCortexHmac(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const m = /^sha256=([0-9a-fA-F]+)$/.exec(signatureHeader.trim());
  if (!m) return false;
  const provided = Buffer.from(m[1]!.toLowerCase(), 'hex');
  const secret = env().UNIESALES_INTAKE_HMAC_SECRET;
  if (!secret) return false;
  const computed = createHmac('sha256', secret).update(rawBody).digest();
  if (provided.length !== computed.length) return false;
  try {
    return timingSafeEqual(provided, computed);
  } catch {
    return false;
  }
}
