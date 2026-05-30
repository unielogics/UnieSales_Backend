-- Migrate Sales Training from per-tag profiles to per-product profiles.
--
-- Old model (one profile per intake (site, tag)):
--   uniewms-talk-to-sales / uniewms-broker-apply / uniewms-warehouse-review
--   unielogics-audit / -join / -get-started / -developer /
--     -industry-problems / -products-inquiry / -services-inquiry
--   uniecortex-audit-request / -partner-application
--   = 12 profiles for the 3 currently-routed sites.
--
-- New model (one profile per product — uniewms / unielogics / uniecortex /
-- unieconnect):
--   - Tag is intake-channel metadata, not a training-routing key.
--   - All tags from a site flow into the same product profile at runtime.
--   - getForRuntime() matches by source_site alone; the lead's custom_fields
--     still carry the tag for the AI to read as channel signal.
--   - UnieConnect is a 4th product the operator wants to train ahead of any
--     public intake going live.
--
-- Safe to re-run. Idempotent ON CONFLICT clauses; the DELETE only touches
-- empty seed-protected tag-level rows; the UPDATE on uniecortex-audit-request
-- is a no-op once it's already been promoted (the WHERE on the old slug
-- won't match).

BEGIN;

-- ── 1. Drop the old constraint ─────────────────────────────────────────────
-- (workspace_id, source_site, source_tag) is no longer the right shape — tag
-- isn't a discriminator anymore. Constraint goes back on at step 5 with a
-- narrower scope (product-level rows only) once the data migration is done.
ALTER TABLE sales_training_profiles
  DROP CONSTRAINT IF EXISTS sales_training_profiles_workspace_source_unique;
DROP INDEX IF EXISTS sales_training_profiles_workspace_source_unique;

-- ── 2. Promote the existing uniecortex-audit-request profile ───────────────
-- It's the only seeded tag-level profile with operator content (23 FAQs +
-- 1 knowledge entry as of migration time). Convert it in place to the
-- product-level UnieCortex profile so the work isn't lost. The other 11
-- tag-level seeds are empty and get deleted below.
UPDATE sales_training_profiles
SET slug = 'uniecortex',
    name = 'UnieCortex',
    source_tag = NULL,
    description = COALESCE(NULLIF(description, ''),
      'Decision intelligence + audit platform for shipper finance teams. Inbound via the public audit form and the server-to-server partner application mirror.'),
    seed_protected = true,
    updated_at = now()
WHERE workspace_id = '00000000-0000-4000-a000-000000000001'
  AND slug = 'uniecortex-audit-request'
  -- Only promote if a product-level uniecortex doesn't already exist
  -- (re-run safety).
  AND NOT EXISTS (
    SELECT 1 FROM sales_training_profiles p2
    WHERE p2.workspace_id = '00000000-0000-4000-a000-000000000001'
      AND p2.slug = 'uniecortex'
  );

-- ── 3. Delete the remaining empty tag-level seeds ──────────────────────────
-- Only touches profiles still marked as seed_protected, still bound to a
-- tag, and with zero content. Anything the operator has added since
-- (FAQs, behavior, knowledge, messages) gets preserved.
DELETE FROM sales_training_profiles p
WHERE p.workspace_id = '00000000-0000-4000-a000-000000000001'
  AND p.seed_protected = true
  AND p.source_site IS NOT NULL
  AND p.source_tag IS NOT NULL
  AND coalesce(jsonb_array_length(p.faqs), 0) = 0
  AND coalesce((SELECT count(*) FROM sales_training_messages m WHERE m.profile_id = p.id), 0) = 0
  AND coalesce((SELECT count(*) FROM sales_training_knowledge k WHERE k.profile_id = p.id), 0) = 0
  AND coalesce((p.behavior->>'pricing'), '') = ''
  AND coalesce((p.behavior->>'demo'), '') = ''
  AND coalesce((p.behavior->>'followup'), '') = ''
  AND coalesce((p.behavior->>'handoff'), '') = '';

-- Any tag-level seed with operator content survives the DELETE. Unseed it
-- so the operator can delete it manually after copying anything they want
-- to keep over to the new product-level profile.
UPDATE sales_training_profiles
SET seed_protected = false, updated_at = now()
WHERE workspace_id = '00000000-0000-4000-a000-000000000001'
  AND source_site IS NOT NULL
  AND source_tag IS NOT NULL
  AND seed_protected = true;

-- ── 4. Insert the 3 remaining product-level profiles ───────────────────────
-- uniewms / unielogics / unieconnect. (uniecortex was promoted above.)
-- ON CONFLICT keeps the re-run idempotent.
INSERT INTO sales_training_profiles
  (workspace_id, slug, name, description, source_site, source_tag, status, seed_protected)
VALUES
  ('00000000-0000-4000-a000-000000000001', 'uniewms', 'UnieWMS',
   'Warehouse management system for high-volume 3PLs and e-commerce sellers. Inbound via talk-to-sales, broker-program/apply, and warehouse-review forms.',
   'uniewms', NULL, 'needs_setup', true),
  ('00000000-0000-4000-a000-000000000001', 'unielogics', 'UnieLogics',
   'Logistics audit + carrier negotiation platform. Inbound via audit, join, get-started, developer, industry-problems, products-inquiry, and services-inquiry forms.',
   'unielogics', NULL, 'needs_setup', true),
  ('00000000-0000-4000-a000-000000000001', 'unieconnect', 'UnieConnect',
   'Integration + channel layer connecting carriers, WMS instances, and partner systems. No public intake forms wired yet — train the AI now so it''s ready when the forms ship.',
   'unieconnect', NULL, 'needs_setup', true)
ON CONFLICT (workspace_id, slug) DO UPDATE
  SET name = EXCLUDED.name,
      description = COALESCE(NULLIF(sales_training_profiles.description, ''), EXCLUDED.description),
      source_site = EXCLUDED.source_site,
      source_tag = NULL,
      seed_protected = true,
      updated_at = now();

-- ── 5. Add product-level unique constraint ─────────────────────────────────
-- Now that data is consolidated, enforce that there can be at most one
-- product-level training profile per (workspace, site). Tag-level rows
-- (legacy, kept for any operator content) are exempt because the WHERE
-- clause excludes them.
CREATE UNIQUE INDEX IF NOT EXISTS sales_training_profiles_workspace_site_product_unique
  ON sales_training_profiles (workspace_id, source_site)
  WHERE source_tag IS NULL AND source_site IS NOT NULL;

COMMIT;
