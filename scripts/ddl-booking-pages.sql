-- Booking pages + booking requests.
-- One bookable landing page per user, shareable at /book/<slug>. Public
-- visitors submit the form to record a booking_request; the operator
-- triages and confirms from the Sales Bookings view.

BEGIN;

CREATE TABLE IF NOT EXISTS booking_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  slug text NOT NULL,
  title text NOT NULL,
  intro text,
  products jsonb NOT NULL DEFAULT '[]'::jsonb,
  topics jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_pages_slug_unique ON booking_pages(slug);
CREATE UNIQUE INDEX IF NOT EXISTS booking_pages_user_unique ON booking_pages(user_id);

CREATE TABLE IF NOT EXISTS booking_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_page_id uuid NOT NULL REFERENCES booking_pages(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  guest_name text NOT NULL,
  guest_email text NOT NULL,
  guest_company text,
  guest_phone text,
  products_of_interest jsonb NOT NULL DEFAULT '[]'::jsonb,
  topics jsonb NOT NULL DEFAULT '[]'::jsonb,
  preferred_time text,
  notes text,
  status text NOT NULL DEFAULT 'pending',
  source_url text,
  client_ip text,
  user_agent text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_requests_workspace_created_idx
  ON booking_requests(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS booking_requests_page_created_idx
  ON booking_requests(booking_page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS booking_requests_workspace_status_idx
  ON booking_requests(workspace_id, status);

COMMIT;
