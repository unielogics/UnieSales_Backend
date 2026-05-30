-- Public intake → split-name columns
-- Forms vary: UnieWMS sends a single Name field; UnieCortex sends First/Last
-- already split. We persist all three (contact_name canonical, first_name +
-- last_name derived) so the AI prompts can prefer first_name for greetings.
-- Additive only — existing rows keep contact_name and leave the new columns
-- null. No backfill.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text;
