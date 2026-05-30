-- Additive: 3 new unielogics campaigns for the form expansion (commit 70b71b9).
-- Idempotent. Apply on prod with:
--   psql "$DATABASE_URL" -f scripts/seed-inbound-intake-new-tags-2026-05-26.sql
-- Keep `seed-inbound-intake.sql` in sync (already updated in this commit).

BEGIN;

INSERT INTO campaigns (id, workspace_id, name, status, campaign_type)
VALUES
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
