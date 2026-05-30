/**
 * Sales Training "Test Inbound" service.
 *
 * Powers the pre-launch verification flow in the training workbench: the
 * operator configures a test recipient per (site, tag) form, picks one, edits
 * a realistic example payload, clicks "Send test". This service runs the
 * full AI pipeline against the test lead and delivers a real Gmail message
 * so the operator can read what a production lead would receive — before
 * flipping the workspace auto-reply switch on.
 *
 * Mirrors the `campaign-playground.service.ts` pattern: isolated lead with
 * source='sales_training_test' that the follow-up worker excludes, real
 * Gmail send with `bypassHealthGate=true`.
 *
 * Public surfaces:
 *   - getTestConfigs / setTestConfig / clearTestConfig — CRUD on the
 *     per-tag jsonb map stored on sales_training_profiles.test_configs
 *   - runTestInbound — simulate an intake submission end-to-end
 */

import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/db';
import { leads, type NewLead, type LeadStatus } from '../db/schema/leads';
import { gmailAccounts, type GmailAccount } from '../db/schema/gmail-accounts';
import {
  salesTrainingProfiles,
  type SalesTrainingProfile,
  type TestConfig,
  type TestConfigsMap,
} from '../db/schema/sales-training';
import { ConflictError, NotFoundError, ValidationError, AppError } from '../utils/errors';
import { lookupRouting, type IntakeSite } from '../config/intake-routing';
import { lookupFormSchema } from '../config/intake-form-schemas';
import { splitName } from './util/name-splitter';
import { scoreLead, classifyLead, generateEmail } from './ai-tasks.service';
import { sendEmail } from './gmail.service';

const TEST_SOURCE = 'sales_training_test';

// ─── Helpers ──────────────────────────────────────────────────────────────
async function fetchProfile(
  workspaceId: string,
  profileId: string,
): Promise<SalesTrainingProfile> {
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

function validateEmail(email: string): string {
  const trimmed = email.trim();
  // RFC 5322 is over-engineered; this matches the same shape Zod's z.string().email() does.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new ValidationError('Invalid email address', [
      { field: 'email', reason: 'must be a valid email' },
    ]);
  }
  return trimmed.toLowerCase();
}

function validateTag(profile: SalesTrainingProfile, tag: string): void {
  if (!profile.sourceSite) {
    throw new ValidationError('Custom profiles do not have intake tags', [
      { field: 'tag', reason: 'this profile is not bound to any inbound form' },
    ]);
  }
  if (!lookupFormSchema(profile.sourceSite, tag)) {
    throw new ValidationError('Unknown tag for this product', [
      {
        field: 'tag',
        reason: `${profile.sourceSite}.${tag} has no form schema defined`,
      },
    ]);
  }
}

// ─── Config CRUD ──────────────────────────────────────────────────────────
export async function getTestConfigs(
  workspaceId: string,
  profileId: string,
): Promise<TestConfigsMap> {
  const profile = await fetchProfile(workspaceId, profileId);
  return (profile.testConfigs ?? {}) as TestConfigsMap;
}

export async function setTestConfig(
  workspaceId: string,
  profileId: string,
  tag: string,
  input: { email: string; contactName?: string },
): Promise<TestConfig> {
  const profile = await fetchProfile(workspaceId, profileId);
  validateTag(profile, tag);
  const email = validateEmail(input.email);
  const existing = (profile.testConfigs ?? {}) as TestConfigsMap;
  const next: TestConfig = {
    email,
    contactName: input.contactName?.trim() || existing[tag]?.contactName,
    lastSentAt: existing[tag]?.lastSentAt,
  };
  const merged: TestConfigsMap = { ...existing, [tag]: next };
  const db = getDb();
  await db
    .update(salesTrainingProfiles)
    .set({ testConfigs: merged, updatedAt: new Date() })
    .where(eq(salesTrainingProfiles.id, profileId));
  return next;
}

export async function clearTestConfig(
  workspaceId: string,
  profileId: string,
  tag: string,
): Promise<void> {
  const profile = await fetchProfile(workspaceId, profileId);
  const existing = (profile.testConfigs ?? {}) as TestConfigsMap;
  if (!(tag in existing)) return;
  const next = { ...existing };
  delete next[tag];
  const db = getDb();
  await db
    .update(salesTrainingProfiles)
    .set({ testConfigs: next, updatedAt: new Date() })
    .where(eq(salesTrainingProfiles.id, profileId));
}

// ─── Test send ────────────────────────────────────────────────────────────
export interface TestInboundContact {
  contactName?: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
}

export interface TestInboundInput {
  /** Tag selected by the operator. Must be a known form for this profile's site. */
  tag: string;
  /** Form-specific custom fields exactly as the public intake would send them. */
  fields: Record<string, unknown>;
  /** Optional overrides for the contact-info panel. Most operators only
   *  customize `contactName`; the recipient `email` is taken from the
   *  test-config unless an override is provided here. */
  contact?: TestInboundContact;
}

export interface TestInboundResult {
  leadId: string;
  score: number;
  fit: string;
  scoreReasoning: string;
  temperature: string;
  intentLabels: string[];
  classifySummary: string;
  emailSubject: string;
  emailBody: string;
  sentTo: string;
  gmailMessageId: string;
  gmailThreadId: string;
}

/**
 * Resolve a Gmail account to send the test from. Prefers the campaign's
 * configured account if any; falls back to the first active account on the
 * workspace. Test sends are operator-driven and infrequent, so we don't need
 * the elaborate prereq gate the playground service uses.
 */
async function resolveGmailAccount(
  workspaceId: string,
  campaignId: string,
): Promise<GmailAccount> {
  const db = getDb();
  // First try the campaign's bound account.
  const campaignBound = await db
    .select({ accountId: sql<string | null>`(SELECT gmail_account_id FROM campaigns WHERE id = ${campaignId} LIMIT 1)` })
    .from(salesTrainingProfiles)
    .limit(1);
  const accountId = campaignBound[0]?.accountId;
  if (accountId) {
    const r = await db
      .select()
      .from(gmailAccounts)
      .where(and(eq(gmailAccounts.id, accountId), eq(gmailAccounts.isActive, true)))
      .limit(1);
    if (r[0]) return r[0];
  }
  // Fall back to any active account on the workspace.
  const fallback = await db
    .select()
    .from(gmailAccounts)
    .where(and(eq(gmailAccounts.workspaceId, workspaceId), eq(gmailAccounts.isActive, true)))
    .limit(1);
  if (!fallback[0]) {
    throw new ConflictError('No active Gmail account on this workspace', [
      { field: 'gmailAccount', reason: 'connect a Gmail account in Settings before running a test send' },
    ]);
  }
  return fallback[0];
}

export async function runTestInbound(
  workspaceId: string,
  profileId: string,
  input: TestInboundInput,
): Promise<TestInboundResult> {
  const db = getDb();
  const profile = await fetchProfile(workspaceId, profileId);
  validateTag(profile, input.tag);
  const site = profile.sourceSite as IntakeSite;
  const tag = input.tag;
  const schema = lookupFormSchema(site, tag)!;

  // Resolve the campaign — same routing the public intake endpoint uses, so
  // the test lead lands in the same campaign a real submission would.
  const routing = lookupRouting(site, tag);
  if (!routing) {
    throw new ValidationError('No campaign routing for this form', [
      { field: 'tag', reason: `${site}.${tag} not in SOURCE_ROUTING — re-run scripts/seed-inbound-intake.sql` },
    ]);
  }
  if (routing.workspaceId !== workspaceId) {
    // Defensive: the profile and the campaign must belong to the same
    // workspace; intake-routing.ts pins all inbound campaigns to the
    // Inbound workspace today.
    throw new ConflictError('Routing mismatch — profile workspace ≠ campaign workspace', [
      { field: 'workspaceId', reason: 'open Sales Training from the Inbound workspace' },
    ]);
  }
  const campaignId = routing.campaignId;

  // Pull the test config — operator must have set this for the tag.
  const configs = (profile.testConfigs ?? {}) as TestConfigsMap;
  const cfg = configs[tag];
  if (!cfg?.email) {
    throw new ValidationError('No test email configured for this form', [
      {
        field: 'testConfig',
        reason: 'add a test recipient on the Test Inbound row before running',
      },
    ]);
  }

  // Build the contact. Override-by-override precedence: explicit input.contact
  // → config defaults → schema example. The recipient is ALWAYS the config
  // email (the operator's inbox); a per-send override on `contact.email`
  // would just override the lead row's email field, not the actual To:.
  const contactName =
    input.contact?.contactName?.trim() ||
    cfg.contactName ||
    schema.exampleContact.contactName ||
    'Operator (Test)';
  const phone = input.contact?.phone?.trim() || schema.exampleContact.phone || null;
  const company =
    input.contact?.company?.trim() || schema.exampleContact.company || null;
  const title = input.contact?.title?.trim() || schema.exampleContact.title || null;

  // Unique-suffix the email so subsequent test sends don't collide with the
  // (workspace, lower(email), campaign) partial unique index on leads. Gmail
  // plus-addressing routes franco-test+sttest123@... to franco-test@..., so
  // the operator still receives every test in the same inbox.
  const recipient = cfg.email.toLowerCase();
  const [recipLocal, recipDomain] = recipient.split('@');
  if (!recipLocal || !recipDomain) {
    throw new ValidationError('Test recipient is not a valid email', [
      { field: 'testConfig.email', reason: 'malformed address' },
    ]);
  }
  const suffix = randomBytes(3).toString('hex'); // 6-hex-char unique tag
  const leadEmail = `${recipLocal}+sttest${suffix}@${recipDomain}`;
  const sendTo = recipient; // deliver to the canonical inbox

  // Name split — same logic intake.service uses.
  const split = splitName(contactName);
  const firstName = split.first;
  const lastName = split.last;

  // Compose the envelope the AI sees in custom_fields. Identical shape to
  // what `intake.service.submit()` writes for a real submission.
  const fields = input.fields ?? {};
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      flat[k] = String(v);
    }
  }
  const customFields = {
    site,
    tag,
    page_url: schema.publicUrl,
    contact: {
      contactName,
      email: leadEmail,
      phone: phone ?? undefined,
      company: company ?? undefined,
      title: title ?? undefined,
    },
    fields,
    meta: {
      submittedAt: new Date().toISOString(),
      submitterType: 'sales_training_test',
    },
    flat,
  } as unknown as Record<string, string>;

  // 1. Insert the test lead.
  const insertValues: NewLead = {
    workspaceId,
    campaignId,
    email: leadEmail,
    contactName,
    firstName,
    lastName,
    phone,
    companyName: company,
    title,
    source: TEST_SOURCE,
    sourceUrl: schema.publicUrl,
    sourceNotes: typeof fields['notes'] === 'string' ? (fields['notes'] as string) : null,
    customFields,
    status: 'pending_review' as LeadStatus,
    importOrigin: 'intake',
  };
  const [leadRow] = await db
    .insert(leads)
    .values(insertValues)
    .returning({ id: leads.id });
  if (!leadRow) {
    throw new AppError('Failed to insert test lead', 500);
  }
  const leadId = leadRow.id;

  // 2. Score + classify so the operator sees the same triage the runner
  //    would produce. We do NOT call post-intake-runner — it would create
  //    a review_ai_draft task and pollute the operator's task queue with
  //    test artifacts.
  const scoreRes = await scoreLead({ workspaceId, campaignId, leadId });
  const classifyRes = await classifyLead({ workspaceId, campaignId, leadId });

  // Persist score back on the lead row so the Inbound view shows it.
  await db
    .update(leads)
    .set({
      leadScore: scoreRes.output.score,
      leadScoreReason: scoreRes.output.reasoning,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, leadId));

  // 3. Generate the AI's first-reply draft.
  const draft = await generateEmail({
    workspaceId,
    campaignId,
    leadId,
    stage: 'cold',
  });

  // 4. Resolve sending Gmail account + actually send.
  const account = await resolveGmailAccount(workspaceId, campaignId);
  const sent = await sendEmail({
    workspaceId,
    gmailAccountId: account.id,
    to: sendTo,
    subject: draft.output.subject,
    body: draft.output.body,
    campaignId,
    leadId,
    // Test sends bypass the at-risk health gate so they work pre-launch
    // even before the operator has built reputation. A paused account
    // still blocks.
    bypassHealthGate: true,
  });

  // 5. Stamp lastSentAt on the test_configs map.
  const refreshed = await fetchProfile(workspaceId, profileId);
  const refreshedConfigs = (refreshed.testConfigs ?? {}) as TestConfigsMap;
  const existingCfg = refreshedConfigs[tag] ?? cfg;
  await db
    .update(salesTrainingProfiles)
    .set({
      testConfigs: {
        ...refreshedConfigs,
        [tag]: { ...existingCfg, lastSentAt: new Date().toISOString() },
      },
      updatedAt: new Date(),
    })
    .where(eq(salesTrainingProfiles.id, profileId));

  return {
    leadId,
    score: scoreRes.output.score,
    fit: scoreRes.output.fit,
    scoreReasoning: scoreRes.output.reasoning,
    temperature: classifyRes.output.temperature,
    intentLabels: classifyRes.output.intent_labels,
    classifySummary: classifyRes.output.summary,
    emailSubject: draft.output.subject,
    emailBody: draft.output.body,
    sentTo: sendTo,
    gmailMessageId: sent.gmailMessageId,
    gmailThreadId: sent.gmailThreadId,
  };
}
