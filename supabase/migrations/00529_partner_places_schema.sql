-- 00529_partner_places_schema.sql
-- Partner places: an admin-configured business that gives a perk to any
-- passenger whose ride ends there. The business absorbs the perk — nothing
-- in this feature touches wallets or the ledger.
--
-- Standalone by design: no FK to cuba_pois. Eligibility is decided by
-- proximity to the ride's dropoff, so a passenger who reached the business
-- through ordinary address search still earns the coupon. See
-- docs/superpowers/specs/2026-07-31-partner-places-discounts-design.md

CREATE TABLE IF NOT EXISTS public.partner_places (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  location             GEOGRAPHY(Point, 4326) NOT NULL,
  address              TEXT,
  municipality         TEXT,
  province             TEXT,
  category             TEXT NOT NULL DEFAULT 'other',
  photo_url            TEXT,
  benefit_title        TEXT NOT NULL,
  benefit_description  TEXT NOT NULL,
  terms                TEXT,
  radius_m             INT NOT NULL DEFAULT 80  CHECK (radius_m BETWEEN 20 AND 2000),
  coupon_ttl_minutes   INT NOT NULL DEFAULT 120 CHECK (coupon_ttl_minutes BETWEEN 15 AND 10080),
  -- 0 = unlimited. Parked knob: the user chose no frequency cap, but a
  -- business that gets burned will ask for one and this avoids a code change.
  cooldown_days        INT NOT NULL DEFAULT 0   CHECK (cooldown_days >= 0),
  is_active            BOOLEAN NOT NULL DEFAULT true,
  valid_until          TIMESTAMPTZ,
  phone                TEXT,
  hours                TEXT,
  created_by           UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves proximity lookups that pass a SCALAR radius, e.g. the discovery RPC
-- get_nearby_partner_places. It deliberately does NOT serve the issuance
-- trigger in 00530: that predicate is
--   ST_DWithin(pp.location, <dropoff>, pp.radius_m)
-- and because the radius is a column of the indexed relation, PostGIS cannot
-- rewrite it into an index qual. Verified with EXPLAIN on 500 rows and
-- enable_seqscan=off: a constant radius gives "Index Scan ... Index Cond:
-- location && _st_expand(...)", the column-valued radius still gives
-- "Seq Scan ... Filter: st_dwithin(location, ..., (radius_m)::float8)".
-- That is acceptable — partner_places is small and admin-curated — but do not
-- read a slow ride completion as a missing index, and do not "optimize" the
-- trigger on the assumption that this index applies to it.
CREATE INDEX IF NOT EXISTS partner_places_location_gix
  ON public.partner_places USING GIST (location);
CREATE INDEX IF NOT EXISTS partner_places_active_idx
  ON public.partner_places (is_active) WHERE is_active;

CREATE TABLE IF NOT EXISTS public.partner_coupons (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_place_id  UUID NOT NULL REFERENCES public.partner_places(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  ride_id           UUID NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  code              TEXT NOT NULL UNIQUE,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  redeemed_at       TIMESTAMPTZ,
  -- 'business' = verified on the public validation page.
  -- 'self'     = the passenger tapped "Ya lo usé". A claim, not evidence.
  redeemed_via      TEXT CHECK (redeemed_via IN ('business', 'self')),
  reminded_at       TIMESTAMPTZ,
  CONSTRAINT partner_coupons_ride_place_uniq UNIQUE (ride_id, partner_place_id)
);

CREATE INDEX IF NOT EXISTS partner_coupons_user_live_idx
  ON public.partner_coupons (user_id, expires_at DESC) WHERE redeemed_at IS NULL;
CREATE INDEX IF NOT EXISTS partner_coupons_place_idx
  ON public.partner_coupons (partner_place_id);
CREATE INDEX IF NOT EXISTS partner_coupons_reminder_idx
  ON public.partner_coupons (expires_at) WHERE redeemed_at IS NULL AND reminded_at IS NULL;

-- ── RLS ───────────────────────────────────────────────────────────────
ALTER TABLE public.partner_places  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_coupons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_places_select_auth ON public.partner_places;
CREATE POLICY partner_places_select_auth ON public.partner_places
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS partner_places_admin_all ON public.partner_places;
CREATE POLICY partner_places_admin_all ON public.partner_places
  FOR ALL TO authenticated
  USING (COALESCE(public.is_admin(), false))
  WITH CHECK (COALESCE(public.is_admin(), false));

-- A passenger sees only their own coupons. No INSERT policy at all:
-- issuance happens exclusively inside the SECURITY DEFINER trigger.
DROP POLICY IF EXISTS partner_coupons_select_own ON public.partner_coupons;
CREATE POLICY partner_coupons_select_own ON public.partner_coupons
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR COALESCE(public.is_admin(), false));

-- ── Config ────────────────────────────────────────────────────────────
INSERT INTO public.platform_config (key, value)
VALUES ('partner_places_discovery_radius_m', '15000')
ON CONFLICT (key) DO NOTHING;

-- ── notifications.type CHECK ──────────────────────────────────────────
-- send-push inserts the category verbatim as notifications.type. Without
-- this the push 400s at the EF and, if it got past, would violate the CHECK.
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'ride','ride_offer','ride_matching','chat','proximity','payment',
    'wallet_recharge','wallet_recharge_refund','wallet_credit','wallet_debit',
    'scheduled_ride','lost_item','dispute_update','sos','delivery','system',
    'promo','announcement','blog','news','campaign','ride_updates',
    'wallet_v2_migration',
    'partner_coupon'
  ]));

COMMENT ON TABLE public.partner_places IS
  '00529 Admin-configured partner businesses. The business absorbs the perk; no ledger involvement.';
COMMENT ON COLUMN public.partner_coupons.redeemed_via IS
  '00529 business = verified on tricigo.com/v; self = passenger self-reported. Only the first is evidence.';
