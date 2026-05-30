/**
 * Sales Training routes — per-product AI training surface.
 *
 * All endpoints require authentication + workspace membership. Routes are
 * grouped under /api/workspaces/:workspaceId/sales/training.
 */
import type { FastifyInstance } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as training from '../services/sales-training.service';
import * as trainingTest from '../services/sales-training-test.service';
import { INTAKE_FORM_SCHEMAS } from '../config/intake-form-schemas';

const FaqSchema = z.object({
  q: z.string().min(1).max(500),
  a: z.string().min(1).max(2000),
});

const BehaviorSchema = z.object({
  pricing: z.string().max(2000).optional(),
  demo: z.string().max(2000).optional(),
  followup: z.string().max(2000).optional(),
  handoff: z.string().max(2000).optional(),
});

const CreateSchema = z.object({
  slug: z.string().min(2).max(60),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  sourceSite: z.string().min(1).max(60).optional(),
  sourceTag: z.string().min(1).max(60).optional(),
});

const PatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  faqs: z.array(FaqSchema).max(80).optional(),
  behavior: BehaviorSchema.optional(),
  crossSell: z.array(z.string().min(1).max(80)).max(20).optional(),
});

const MessageSchema = z.object({
  content: z.string().min(1).max(8000),
});

const KnowledgeCreateSchema = z.object({
  title: z.string().min(1).max(120),
  content: z.string().min(1).max(20000),
});

const KnowledgePatchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  content: z.string().min(1).max(20000).optional(),
  ordinal: z.number().int().min(0).max(1000).optional(),
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

const READ = [requireAuth, requireWorkspaceMembership];
const WRITE = [requireAuth, requireWorkspaceMembership];

export async function registerSalesTrainingRoutes(app: FastifyInstance): Promise<void> {
  // List
  app.get(
    '/api/workspaces/:workspaceId/sales/training',
    { preHandler: READ },
    async (req) => {
      const items = await training.list(req.workspace!.id);
      return ok({ items });
    },
  );

  // Create custom profile
  app.post(
    '/api/workspaces/:workspaceId/sales/training',
    { preHandler: WRITE },
    async (req, reply) => {
      const input = parseBody(CreateSchema, req.body);
      const profile = await training.create(req.workspace!.id, input);
      reply.code(201);
      return ok({ profile });
    },
  );

  // Detail (profile + messages + knowledge)
  app.get(
    '/api/workspaces/:workspaceId/sales/training/:profileId',
    { preHandler: READ },
    async (req) => {
      const { profileId } = z
        .object({ profileId: z.string().uuid() })
        .parse(req.params);
      const detail = await training.get(req.workspace!.id, profileId);
      return ok(detail);
    },
  );

  // Partial update (name/description/faqs/behavior/crossSell)
  app.patch(
    '/api/workspaces/:workspaceId/sales/training/:profileId',
    { preHandler: WRITE },
    async (req) => {
      const { profileId } = z
        .object({ profileId: z.string().uuid() })
        .parse(req.params);
      const input = parseBody(PatchSchema, req.body);
      const profile = await training.update(req.workspace!.id, profileId, input);
      return ok({ profile });
    },
  );

  // Send a chat message (user → AI reply)
  app.post(
    '/api/workspaces/:workspaceId/sales/training/:profileId/messages',
    { preHandler: WRITE },
    async (req) => {
      const { profileId } = z
        .object({ profileId: z.string().uuid() })
        .parse(req.params);
      const input = parseBody(MessageSchema, req.body);
      const result = await training.sendMessage(req.workspace!.id, profileId, input.content);
      return ok(result);
    },
  );

  // Generate trained summary — long-running (~10-30s); no rate limit here,
  // the operator hits this button by hand.
  app.post(
    '/api/workspaces/:workspaceId/sales/training/:profileId/generate',
    { preHandler: WRITE },
    async (req) => {
      const { profileId } = z
        .object({ profileId: z.string().uuid() })
        .parse(req.params);
      const result = await training.generateSummary(req.workspace!.id, profileId);
      return ok({
        summary: result.summary,
        status: 'trained',
        trainedAt: result.trainedAt.toISOString(),
      });
    },
  );

  // ── Test Inbound (pre-launch verification) ──────────────────────────────
  // 5 endpoints: 1 workspace-level (form schemas), 4 per-profile (configs CRUD
  // + run a test send). All gated by the same auth + workspace middleware.

  // Read-only: ship the 12 per-form schemas to the UI so it can render
  // realistic editable forms. No workspace coupling — same schemas for every
  // workspace; future per-workspace overrides land here.
  app.get(
    '/api/workspaces/:workspaceId/sales/training/form-schemas',
    { preHandler: READ },
    async () => {
      return ok({ schemas: INTAKE_FORM_SCHEMAS });
    },
  );

  // Per-profile test config map.
  app.get(
    '/api/workspaces/:workspaceId/sales/training/:profileId/test-configs',
    { preHandler: READ },
    async (req) => {
      const { profileId } = z
        .object({ profileId: z.string().uuid() })
        .parse(req.params);
      const configs = await trainingTest.getTestConfigs(req.workspace!.id, profileId);
      return ok({ configs });
    },
  );

  // Set / update one config (keyed by bare tag — no site prefix; site is on
  // the parent profile).
  app.patch(
    '/api/workspaces/:workspaceId/sales/training/:profileId/test-configs/:tag',
    { preHandler: WRITE },
    async (req) => {
      const { profileId, tag } = z
        .object({
          profileId: z.string().uuid(),
          tag: z.string().min(1).max(60),
        })
        .parse(req.params);
      const input = parseBody(
        z.object({
          email: z.string().email().max(255),
          contactName: z.string().max(120).optional(),
        }),
        req.body,
      );
      const config = await trainingTest.setTestConfig(
        req.workspace!.id,
        profileId,
        tag,
        input,
      );
      return ok({ config });
    },
  );

  app.delete(
    '/api/workspaces/:workspaceId/sales/training/:profileId/test-configs/:tag',
    { preHandler: WRITE },
    async (req) => {
      const { profileId, tag } = z
        .object({
          profileId: z.string().uuid(),
          tag: z.string().min(1).max(60),
        })
        .parse(req.params);
      await trainingTest.clearTestConfig(req.workspace!.id, profileId, tag);
      return ok({ ok: true });
    },
  );

  // Run a test inbound — full AI pipeline → real Gmail send to the
  // configured recipient. Returns score + classification + email body so
  // the UI can show the AI's decisions inline alongside the "delivered"
  // confirmation.
  app.post(
    '/api/workspaces/:workspaceId/sales/training/:profileId/test-inbound',
    { preHandler: WRITE },
    async (req) => {
      const { profileId } = z
        .object({ profileId: z.string().uuid() })
        .parse(req.params);
      const input = parseBody(
        z.object({
          tag: z.string().min(1).max(60),
          fields: z.record(z.unknown()),
          contact: z
            .object({
              contactName: z.string().max(120).optional(),
              email: z.string().email().max(255).optional(),
              phone: z.string().max(40).optional(),
              company: z.string().max(120).optional(),
              title: z.string().max(120).optional(),
            })
            .optional(),
        }),
        req.body,
      );
      const result = await trainingTest.runTestInbound(
        req.workspace!.id,
        profileId,
        input,
      );
      return ok(result);
    },
  );

  // Toggle disabled flag (kill switch — AI hands off instead of drafting).
  // Allowed on seeded profiles; that's the whole point of having a flag
  // separate from the delete path.
  app.patch(
    '/api/workspaces/:workspaceId/sales/training/:profileId/disabled',
    { preHandler: WRITE },
    async (req) => {
      const { profileId } = z
        .object({ profileId: z.string().uuid() })
        .parse(req.params);
      const input = parseBody(z.object({ disabled: z.boolean() }), req.body);
      const profile = await training.setDisabled(
        req.workspace!.id,
        profileId,
        input.disabled,
      );
      return ok({ profile });
    },
  );

  // Kickoff: AI opens the conversation. The frontend fires this on first
  // visit when the chat is empty. Idempotent — returns the existing first
  // message if the chat is already non-empty.
  app.post(
    '/api/workspaces/:workspaceId/sales/training/:profileId/kickoff',
    { preHandler: WRITE },
    async (req) => {
      const { profileId } = z
        .object({ profileId: z.string().uuid() })
        .parse(req.params);
      const assistantMessage = await training.kickoffChat(
        req.workspace!.id,
        profileId,
      );
      return ok({ assistantMessage });
    },
  );

  // Delete (refuses 409 on seed_protected)
  app.delete(
    '/api/workspaces/:workspaceId/sales/training/:profileId',
    { preHandler: WRITE },
    async (req) => {
      const { profileId } = z
        .object({ profileId: z.string().uuid() })
        .parse(req.params);
      await training.remove(req.workspace!.id, profileId);
      return ok({ ok: true });
    },
  );

  // ── Knowledge CRUD (per-profile typed entries, up to 20k chars each) ────
  app.get(
    '/api/workspaces/:workspaceId/sales/training/:profileId/knowledge',
    { preHandler: READ },
    async (req) => {
      const { profileId } = z
        .object({ profileId: z.string().uuid() })
        .parse(req.params);
      const items = await training.listKnowledge(req.workspace!.id, profileId);
      return ok({ items });
    },
  );

  app.post(
    '/api/workspaces/:workspaceId/sales/training/:profileId/knowledge',
    { preHandler: WRITE },
    async (req, reply) => {
      const { profileId } = z
        .object({ profileId: z.string().uuid() })
        .parse(req.params);
      const input = parseBody(KnowledgeCreateSchema, req.body);
      const knowledge = await training.addKnowledge(req.workspace!.id, profileId, input);
      reply.code(201);
      return ok({ knowledge });
    },
  );

  app.patch(
    '/api/workspaces/:workspaceId/sales/training/:profileId/knowledge/:knowledgeId',
    { preHandler: WRITE },
    async (req) => {
      const { profileId, knowledgeId } = z
        .object({ profileId: z.string().uuid(), knowledgeId: z.string().uuid() })
        .parse(req.params);
      const input = parseBody(KnowledgePatchSchema, req.body);
      const knowledge = await training.updateKnowledge(
        req.workspace!.id,
        profileId,
        knowledgeId,
        input,
      );
      return ok({ knowledge });
    },
  );

  app.delete(
    '/api/workspaces/:workspaceId/sales/training/:profileId/knowledge/:knowledgeId',
    { preHandler: WRITE },
    async (req) => {
      const { profileId, knowledgeId } = z
        .object({ profileId: z.string().uuid(), knowledgeId: z.string().uuid() })
        .parse(req.params);
      await training.removeKnowledge(req.workspace!.id, profileId, knowledgeId);
      return ok({ ok: true });
    },
  );

  // ── File-upload variants for FAQ / Behavior / Knowledge ─────────────────
  // Multipart is registered globally by knowledge.routes earlier in the
  // bootstrap order — req.file() works here without re-registering.

  // Knowledge: PDF / DOCX / TXT / MD / CSV / JSON → text → one knowledge entry.
  app.post(
    '/api/workspaces/:workspaceId/sales/training/:profileId/knowledge/upload',
    { preHandler: WRITE },
    async (req, reply) => {
      const { profileId } = z
        .object({ profileId: z.string().uuid() })
        .parse(req.params);
      const part: MultipartFile | undefined = await req.file();
      if (!part) {
        throw new ValidationError('No file uploaded', [
          { field: 'file', reason: 'multipart file required' },
        ]);
      }
      const buffer = await part.toBuffer();
      const knowledge = await training.addKnowledgeFromFile(
        req.workspace!.id,
        profileId,
        { fileName: part.filename ?? 'upload.txt', buffer, mime: part.mimetype },
      );
      reply.code(201);
      return ok({ knowledge });
    },
  );

  // FAQs: bulk import from CSV (column-parsed) or PDF / TXT / MD
  // (AI-extracted via Claude Sonnet). Merges into the existing faqs array,
  // deduped by question text.
  app.post(
    '/api/workspaces/:workspaceId/sales/training/:profileId/faqs/import',
    { preHandler: WRITE },
    async (req) => {
      const { profileId } = z
        .object({ profileId: z.string().uuid() })
        .parse(req.params);
      const part: MultipartFile | undefined = await req.file();
      if (!part) {
        throw new ValidationError('No file uploaded', [
          { field: 'file', reason: 'multipart file required' },
        ]);
      }
      const buffer = await part.toBuffer();
      const result = await training.importFaqsFromFile(
        req.workspace!.id,
        profileId,
        { fileName: part.filename ?? 'upload', buffer, mime: part.mimetype },
      );
      return ok({
        profile: result.profile,
        added: result.added,
        skipped: result.skipped,
        method: result.method,
      });
    },
  );

  // Behavior: parse a PDF / TXT / MD into the 4 fields. TXT/MD with explicit
  // section markers uses the cheap deterministic parser; everything else runs
  // through Claude Sonnet which maps free-form content to the 4 fields.
  app.post(
    '/api/workspaces/:workspaceId/sales/training/:profileId/behavior/import',
    { preHandler: WRITE },
    async (req) => {
      const { profileId } = z
        .object({ profileId: z.string().uuid() })
        .parse(req.params);
      const part: MultipartFile | undefined = await req.file();
      if (!part) {
        throw new ValidationError('No file uploaded', [
          { field: 'file', reason: 'multipart file required' },
        ]);
      }
      const buffer = await part.toBuffer();
      const result = await training.importBehaviorFromFile(
        req.workspace!.id,
        profileId,
        { fileName: part.filename ?? 'upload', buffer, mime: part.mimetype },
      );
      return ok({
        profile: result.profile,
        updatedFields: result.updatedFields,
        method: result.method,
      });
    },
  );
}
