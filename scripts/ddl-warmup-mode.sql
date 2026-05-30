-- Adds campaigns.warmup_mode — true while a launched campaign is still in
-- operator-driven warm-up (manual sends only), cleared by "Activate Campaign".
-- Safe to run repeatedly.
-- Apply on EC2:  psql "$DATABASE_URL" -f scripts/ddl-warmup-mode.sql
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS warmup_mode boolean NOT NULL DEFAULT false;
