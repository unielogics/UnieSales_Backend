-- Per-workspace scheduling config (working hours, call length, blocked time).
-- Null → backend falls back to DEFAULT_CALENDAR_CONFIG.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS calendar_config jsonb;
