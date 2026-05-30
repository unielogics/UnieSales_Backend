-- Per-workspace outbound email config: HTML footer/signature, AI voice guide,
-- and pasted sample emails. Safe to run repeatedly.
-- Apply on EC2:  psql "$DATABASE_URL" -f scripts/ddl-email-config.sql
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS email_footer_html text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS email_style_guide text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS email_samples jsonb;
