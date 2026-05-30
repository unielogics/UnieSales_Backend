-- Booking calendar — availability config on booking_pages, slot bookkeeping
-- on booking_requests. Additive; safe to re-run.

ALTER TABLE booking_pages
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS duration_minutes integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS buffer_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS days_into_future integer NOT NULL DEFAULT 14,
  ADD COLUMN IF NOT EXISTS min_lead_hours integer NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS working_hours jsonb NOT NULL DEFAULT
    '[{"weekday":1,"start":"09:00","end":"17:00"},{"weekday":2,"start":"09:00","end":"17:00"},{"weekday":3,"start":"09:00","end":"17:00"},{"weekday":4,"start":"09:00","end":"17:00"},{"weekday":5,"start":"09:00","end":"17:00"}]'::jsonb;

ALTER TABLE booking_requests
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS slot_key text;

CREATE INDEX IF NOT EXISTS booking_requests_page_slot_idx
  ON booking_requests (booking_page_id, slot_key);
