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
  -- The business's secret validation link: tricigo.com/v/<validation_token>.
  -- This is the IDENTITY of the validating shop and the rate-limit bucket for
  -- the public endpoints. See the idempotent ALTER below for the shape and the
  -- reasoning, and 00531 for how it is used.
  validation_token     TEXT NOT NULL UNIQUE DEFAULT encode(extensions.gen_random_bytes(6), 'hex'),
  created_by           UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── validation_token, idempotently ────────────────────────────────────
-- The CREATE TABLE above only fires on a fresh database. Everything in this
-- block brings an ALREADY-EXISTING partner_places (QA, or any environment
-- that applied an earlier 00529) to the same shape.
--
-- Shape: 12 lowercase hex characters — encode(gen_random_bytes(6), 'hex') —
-- so 2^48 ≈ 2.8e14 possibilities. Deliberately NOT the coupon alphabet of
-- 00530: that alphabet drops 0/1/I/L/O because a coupon code is read aloud
-- across a noisy counter, whereas this token lives in a URL an employee
-- bookmarks and occasionally retypes, where lowercase hex carries no case
-- ambiguity and survives being copied out of a chat message or off paper.
ALTER TABLE public.partner_places
  ADD COLUMN IF NOT EXISTS validation_token TEXT;

-- Set separately from ADD COLUMN so the default lands whether the column was
-- just created or already existed without one.
ALTER TABLE public.partner_places
  ALTER COLUMN validation_token SET DEFAULT encode(extensions.gen_random_bytes(6), 'hex');

-- gen_random_bytes is VOLATILE, so this is evaluated once PER ROW: every
-- existing business gets its own distinct token, not one shared value.
UPDATE public.partner_places
SET validation_token = encode(extensions.gen_random_bytes(6), 'hex')
WHERE validation_token IS NULL;

ALTER TABLE public.partner_places
  ALTER COLUMN validation_token SET NOT NULL;

-- On a fresh database the inline UNIQUE above already created an index of
-- exactly this name, so this is a no-op there and does the work on re-apply.
CREATE UNIQUE INDEX IF NOT EXISTS partner_places_validation_token_key
  ON public.partner_places (validation_token);

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

-- validation_token is a SECRET, and the policy directly above is
-- `USING (true)` over a table that `authenticated` holds a table-level SELECT
-- grant on. Without what follows, any logged-in passenger could simply ask
-- PostgREST for  /partner_places?select=validation_token  and walk away with
-- every business's validation link — which would hand them exactly the two
-- capabilities 00531 exists to deny: redeeming coupons at a shop they are not
-- standing in, and exhausting a chosen shop's rate-limit bucket on purpose.
-- RLS is row-level and cannot withhold a column, so column privileges are the
-- only mechanism available.
--
-- `REVOKE SELECT (validation_token)` ALONE IS A SILENT NO-OP, and was the
-- first attempt here. Column privileges are ADDITIVE with the table-level
-- grant: revoking a column privilege removes a column-specific grant, and
-- there was none — the read was permitted by the blanket table-level SELECT.
-- Verified rather than assumed: after that revoke, a `SET ROLE authenticated`
-- session still read a real token out of the table. The only thing that works
-- is to drop the table-wide SELECT and hand back the non-secret columns
-- explicitly. Same shape of trap as `REVOKE ... FROM PUBLIC` on functions
-- (see 00530): the statement succeeds and changes nothing.
--
-- anon is not re-granted at all. It has no SELECT policy on this table, so it
-- could never see a row anyway; leaving it without the grant is one less thing
-- depending on an RLS policy staying correct.
REVOKE SELECT ON public.partner_places FROM PUBLIC, anon, authenticated;

-- Every column EXCEPT validation_token. Enumerated, which means a column added
-- later is invisible to clients until it is added here — the safe direction to
-- fail: a missing column is a visible bug, a leaked token is a silent one.
GRANT SELECT (
  id, name, location, address, municipality, province, category, photo_url,
  benefit_title, benefit_description, terms, radius_m, coupon_ttl_minutes,
  cooldown_days, is_active, valid_until, phone, hours, created_by,
  created_at, updated_at
) ON public.partner_places TO authenticated;

-- Note for whoever builds the admin UI: `SELECT *` on partner_places now fails
-- for `authenticated`, admins included, and the admin needs this token to hand
-- the link to the business. Read it through a SECURITY DEFINER function gated
-- on is_admin() — the function owner owns the table, so column privileges do
-- not apply to it, which is exactly how 00531's validate/redeem reach it. Do
-- not "fix" a permission-denied error here by granting the column back.

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
VALUES
  ('partner_places_discovery_radius_m', '15000'),
  -- Budget for the login-free validate/redeem endpoints, per business per
  -- window (00531 keys the bucket on partner_place_id). Configurable rather
  -- than hard-coded because it is the one security-relevant number that an
  -- incident might need changed in minutes, and a migration is the wrong
  -- instrument for that. A per-business budget can be far more generous than
  -- the old global-ish one: 60 in 10 minutes is a busy counter, not an attack.
  ('coupon_validate_max_per_window', '60'),
  ('coupon_validate_window_s',       '600')
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
COMMENT ON COLUMN public.partner_places.validation_token IS
  '00529 SECRET. 12 hex chars identifying this business on tricigo.com/v/<token>. It is both the authorisation to validate coupons and the rate-limit bucket key (00531). Revoked from anon/authenticated at the column level — never expose it through a table SELECT.';
COMMENT ON COLUMN public.partner_coupons.redeemed_via IS
  '00529 business = verified on tricigo.com/v; self = passenger self-reported. Only the first is evidence.';
