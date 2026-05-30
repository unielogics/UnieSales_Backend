-- Seed the Inbound workspace + 9 source-tagged campaigns for public intake.
-- Idempotent: uses deterministic UUIDs + ON CONFLICT DO NOTHING so reruns
-- (and prod ↔ dev parity) are safe.
--
-- The intake.service resolves (site, tag) → { workspaceId, campaignId } from
-- a TypeScript map in config/intake-routing.ts that mirrors these UUIDs.
-- DO NOT change the UUIDs without updating that file in lockstep.

BEGIN;

-- 1) The Inbound workspace itself
INSERT INTO workspaces (id, name, company_name, brand_name, industry, default_sender_name, is_active)
VALUES (
  '00000000-0000-4000-a000-000000000001',
  'Inbound',
  'UnieLogics',
  'UnieSales',
  'Inbound lead intake',
  'Franco',
  true
)
ON CONFLICT (id) DO NOTHING;

-- 2) Make Franco an owner of the Inbound workspace. We resolve his user_id by
--    email rather than hardcoding a UUID so this is portable across environments.
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT '00000000-0000-4000-a000-000000000001'::uuid, u.id, 'owner'
FROM users u
WHERE lower(u.email) = 'franco@unielogics.com'
  AND NOT EXISTS (
    SELECT 1 FROM workspace_members m
    WHERE m.workspace_id = '00000000-0000-4000-a000-000000000001'::uuid AND m.user_id = u.id
  );

-- 3) One campaign per (site, tag). Naming convention: <site>_<tag>.
--    Campaign UUIDs end in a stable, hand-picked suffix for easy mental mapping.
--    These must match config/intake-routing.ts.
INSERT INTO campaigns (id, workspace_id, name, status, campaign_type)
VALUES
  -- UnieWMS forms
  ('00000000-0000-4001-a000-000000000001'::uuid,
    '00000000-0000-4000-a000-000000000001'::uuid,
    'uniewms_talk_to_sales', 'active', 'inbound'),
  ('00000000-0000-4001-a000-000000000002'::uuid,
    '00000000-0000-4000-a000-000000000001'::uuid,
    'uniewms_broker_apply', 'active', 'inbound'),
  ('00000000-0000-4001-a000-000000000003'::uuid,
    '00000000-0000-4000-a000-000000000001'::uuid,
    'uniewms_warehouse_review', 'active', 'inbound'),
  -- UnieLogics forms
  ('00000000-0000-4001-a000-000000000004'::uuid,
    '00000000-0000-4000-a000-000000000001'::uuid,
    'unielogics_audit', 'active', 'inbound'),
  ('00000000-0000-4001-a000-000000000005'::uuid,
    '00000000-0000-4000-a000-000000000001'::uuid,
    'unielogics_join', 'active', 'inbound'),
  ('00000000-0000-4001-a000-000000000006'::uuid,
    '00000000-0000-4000-a000-000000000001'::uuid,
    'unielogics_get_started', 'active', 'inbound'),
  ('00000000-0000-4001-a000-000000000007'::uuid,
    '00000000-0000-4000-a000-000000000001'::uuid,
    'unielogics_developer', 'active', 'inbound'),
  -- UnieCortex forms (server-to-server mirror with HMAC)
  ('00000000-0000-4001-a000-000000000008'::uuid,
    '00000000-0000-4000-a000-000000000001'::uuid,
    'uniecortex_audit_request', 'active', 'inbound'),
  ('00000000-0000-4001-a000-000000000009'::uuid,
    '00000000-0000-4000-a000-000000000001'::uuid,
    'uniecortex_partner_application', 'active', 'inbound'),
  -- Added 2026-05-26 alongside the unielogics.com form expansion.
  ('00000000-0000-4001-a000-000000000010'::uuid,
    '00000000-0000-4000-a000-000000000001'::uuid,
    'unielogics_industry_problems', 'active', 'inbound'),
  ('00000000-0000-4001-a000-000000000011'::uuid,
    '00000000-0000-4000-a000-000000000001'::uuid,
    'unielogics_products_inquiry', 'active', 'inbound'),
  ('00000000-0000-4001-a000-000000000012'::uuid,
    '00000000-0000-4000-a000-000000000001'::uuid,
    'unielogics_services_inquiry', 'active', 'inbound')
ON CONFLICT (id) DO NOTHING;

COMMIT;
