-- Per-campaign custom fields imported from CSV/Sheet column mappings.
-- Schema-less by design: each campaign decides its own keys. Values are
-- always strings (matches the way CSV cells arrive). The AI consumes this
-- map alongside the lead's structured columns.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS custom_fields jsonb;
