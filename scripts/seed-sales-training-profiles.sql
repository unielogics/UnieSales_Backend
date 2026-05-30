-- Seed: 12 sales training profiles, one per (site, tag) currently routed by
-- public-intake. Idempotent. Updates name on re-run so renames flow through.
-- All seeded rows have seed_protected=true; the operator can edit content but
-- can't DELETE them.

BEGIN;

INSERT INTO sales_training_profiles (
  workspace_id, slug, name, source_site, source_tag, seed_protected, status
)
VALUES
  -- uniewms (3)
  ('00000000-0000-4000-a000-000000000001', 'uniewms-talk-to-sales',
    'UnieWMS · Talk to Sales',     'uniewms', 'talk_to_sales',     true, 'needs_setup'),
  ('00000000-0000-4000-a000-000000000001', 'uniewms-broker-apply',
    'UnieWMS · Broker Apply',      'uniewms', 'broker_apply',      true, 'needs_setup'),
  ('00000000-0000-4000-a000-000000000001', 'uniewms-warehouse-review',
    'UnieWMS · Warehouse Review',  'uniewms', 'warehouse_review',  true, 'needs_setup'),
  -- unielogics (7)
  ('00000000-0000-4000-a000-000000000001', 'unielogics-audit',
    'UnieLogics · Audit',          'unielogics', 'audit',          true, 'needs_setup'),
  ('00000000-0000-4000-a000-000000000001', 'unielogics-join',
    'UnieLogics · Join',           'unielogics', 'join',           true, 'needs_setup'),
  ('00000000-0000-4000-a000-000000000001', 'unielogics-get-started',
    'UnieLogics · Get Started',    'unielogics', 'get_started',    true, 'needs_setup'),
  ('00000000-0000-4000-a000-000000000001', 'unielogics-developer',
    'UnieLogics · Developer',      'unielogics', 'developer',      true, 'needs_setup'),
  ('00000000-0000-4000-a000-000000000001', 'unielogics-industry-problems',
    'UnieLogics · Industry Problems', 'unielogics', 'industry_problems', true, 'needs_setup'),
  ('00000000-0000-4000-a000-000000000001', 'unielogics-products-inquiry',
    'UnieLogics · Products Inquiry',  'unielogics', 'products_inquiry',  true, 'needs_setup'),
  ('00000000-0000-4000-a000-000000000001', 'unielogics-services-inquiry',
    'UnieLogics · Services Inquiry',  'unielogics', 'services_inquiry',  true, 'needs_setup'),
  -- uniecortex (2)
  ('00000000-0000-4000-a000-000000000001', 'uniecortex-audit-request',
    'UnieCortex · Audit Request',  'uniecortex', 'audit_request',     true, 'needs_setup'),
  ('00000000-0000-4000-a000-000000000001', 'uniecortex-partner-application',
    'UnieCortex · Partner Application', 'uniecortex', 'partner_application', true, 'needs_setup')
ON CONFLICT (workspace_id, slug) DO UPDATE SET
  name = EXCLUDED.name,
  source_site = EXCLUDED.source_site,
  source_tag = EXCLUDED.source_tag,
  seed_protected = true,
  updated_at = now();

COMMIT;
