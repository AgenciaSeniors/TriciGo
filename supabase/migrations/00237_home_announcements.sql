-- ============================================================
-- Migration 00237: home_announcements
--
-- Content cards displayed on the rider home (between Promos and
-- Novedades). Distinct from `campaigns` (which is the dispatch
-- record for push/email/SMS sends) — these are in-app banners
-- with optional CTA, image, city scoping, and time window.
-- ============================================================

CREATE TABLE IF NOT EXISTS home_announcements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_es      text NOT NULL,
  body_es       text,
  image_url     text,
  cta_label_es  text,
  -- Supports internal deep links (tricigo://promo/X) and external https URLs
  cta_url       text,
  is_active     boolean NOT NULL DEFAULT false,
  -- NULL = always visible once is_active=true
  starts_at     timestamptz,
  ends_at       timestamptz,
  -- NULL = visible to all cities; UUID = scoped to that city only
  city_id       uuid REFERENCES cities(id) ON DELETE SET NULL,
  -- Higher = shown first
  priority      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_home_announcements_active
  ON home_announcements (is_active, priority DESC, created_at DESC)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_home_announcements_city
  ON home_announcements (city_id)
  WHERE city_id IS NOT NULL;

ALTER TABLE home_announcements ENABLE ROW LEVEL SECURITY;

-- Public read: only currently-live rows (is_active AND within window)
CREATE POLICY "ha_public_read" ON home_announcements
  FOR SELECT
  USING (
    is_active
    AND (starts_at IS NULL OR starts_at <= now())
    AND (ends_at IS NULL OR ends_at > now())
  );

-- Admin: full CRUD
CREATE POLICY "ha_admin_all" ON home_announcements
  FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION home_announcements_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_home_announcements_updated_at ON home_announcements;
CREATE TRIGGER trg_home_announcements_updated_at
  BEFORE UPDATE ON home_announcements
  FOR EACH ROW EXECUTE FUNCTION home_announcements_set_updated_at();
