-- Mobile notification backend (Phase 2). Additive, idempotent.
-- Run: psql "$DATABASE_URL" -f scripts/ddl-notifications.sql

BEGIN;

CREATE TABLE IF NOT EXISTS notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,   -- null = workspace-wide
  kind         text NOT NULL,         -- handoff|booking|draft|reply|objection|won|lost|score|risk|summary
  priority     text NOT NULL DEFAULT 'normal',  -- urgent|high|normal|low
  title        text NOT NULL,
  body         text,
  meta         text,
  lead_id      uuid REFERENCES leads(id) ON DELETE SET NULL,
  thread_id    uuid,
  read_at      timestamp,
  created_at   timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notif_workspace_created_idx ON notifications (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notif_workspace_unread_idx  ON notifications (workspace_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notif_user_idx              ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_settings (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  per_kind            jsonb NOT NULL DEFAULT '{}'::jsonb,
  quiet_hours_enabled boolean NOT NULL DEFAULT true,
  quiet_hours_start   text NOT NULL DEFAULT '21:00',
  quiet_hours_end     text NOT NULL DEFAULT '07:00',
  created_at          timestamp NOT NULL DEFAULT now(),
  updated_at          timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_token  text,            -- FCM registration token
  endpoint      text,            -- Web Push (future)
  p256dh_key    text,
  auth_key      text,
  device_label  text,
  platform      text NOT NULL,   -- 'android-fcm' | 'web-push'
  created_at    timestamp NOT NULL DEFAULT now(),
  last_used_at  timestamp NOT NULL DEFAULT now()
);
-- Dedup a device per user. NULLs are distinct in a UNIQUE index, so multiple
-- web-push rows (device_token NULL) won't collide; FCM rows dedup on the token.
CREATE UNIQUE INDEX IF NOT EXISTS push_sub_user_token_unique
  ON push_subscriptions (user_id, device_token);

COMMIT;
