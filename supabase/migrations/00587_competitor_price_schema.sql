-- 00587 — Competitor price observatory: schema
--
-- The owner already tracks competitor fares BY HAND (see PR #965 / migration
-- 00569: a screenshot of La Nave's/Cinco's fare-estimate screen, transcribed
-- into a pricing migration). This is the data layer that turns that manual,
-- once-in-a-while snapshot into a 24/7 series.
--
-- What it stores, per competitor (La Nave, Cinco — both TRANSPORT apps, direct
-- competitors, not stores):
--   * competitor_routes         — the FIXED basket of routes we re-quote over time
--   * competitor_category_map   — which of their categories maps to which TriciGo type
--   * competitor_quotes         — every captured quote, PAIRED with TriciGo's own
--                                 price for the same route in the same instant
--   * competitor_sessions       — the session credential the owner's phone deposits
--
-- Why pair with our own price in the same row: TriciGo's tariff is rewritten
-- roughly every 15 min (migration 00441 makes the USD price the source of truth
-- and recompute_cup_from_usd_prices() rewrites service_type_configs +
-- pricing_rules on every FX change; FX syncs every 15 min). A competitor quote
-- compared against a tariff from another hour compares nothing. The capturing
-- Edge Function (00588) computes tricigo_price_cup in the same cycle.
--
-- Scope guardrails baked into the design: PRICES ONLY. No driver names, phones,
-- or plates — the adapters trim `raw` before persisting. No real rides are ever
-- requested; only the fare-estimate endpoint (which dispatches no one).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. competitor_routes — the FIXED basket
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.competitor_routes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label         text NOT NULL UNIQUE,          -- "Vedado ↔ Habana Vieja" (unique: idempotent seed + no accidental dupes)
  province      text NOT NULL,                 -- grouping in the admin panel
  pickup_lat    double precision NOT NULL,
  pickup_lng    double precision NOT NULL,
  dropoff_lat   double precision NOT NULL,
  dropoff_lng   double precision NOT NULL,
  -- Route geometry is precomputed ONCE and frozen here. The route is fixed, so
  -- its geometry never changes; and directions-google is OFF by default
  -- (routing_google_enabled=false), so we can't depend on it every cycle. Our
  -- own price is computed from this frozen geometry. NULL until seeded.
  distance_m    integer,
  duration_s    integer,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.competitor_routes IS
  '00587: fixed basket of routes re-quoted 24/7 for competitor price tracking. '
  'distance_m/duration_s are frozen (precomputed once) because the route is fixed '
  'and directions-google is off by default. Human-curated, never written by the bot.';

ALTER TABLE public.competitor_routes ENABLE ROW LEVEL SECURITY;

-- Admin read (the panel). Writes: super_admin / SECURITY DEFINER only — the
-- basket is curated by a human, not the bot.
DROP POLICY IF EXISTS competitor_routes_admin_read ON public.competitor_routes;
CREATE POLICY competitor_routes_admin_read
  ON public.competitor_routes FOR SELECT USING (public.is_admin());

DROP POLICY IF EXISTS competitor_routes_super_admin_write ON public.competitor_routes;
CREATE POLICY competitor_routes_super_admin_write
  ON public.competitor_routes FOR ALL
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. competitor_category_map — which of their categories ↔ which TriciGo type
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.competitor_category_map (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor          text NOT NULL CHECK (competitor IN ('la_nave', 'cinco')),
  competitor_category text NOT NULL,           -- their raw label, e.g. 'basico' / 'confort'
  tricigo_service_type text NOT NULL,          -- 'auto_standard' | 'auto_confort' | ...
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (competitor, competitor_category)
);

COMMENT ON TABLE public.competitor_category_map IS
  '00587: maps a competitor fare category to the closest TriciGo service type. '
  'The capturing EF emits one competitor_quotes row per active pair. A competitor '
  'category with no row here is ignored; a TriciGo type with no pair is not captured. '
  'Seeded from PR #965 observations (moto/triciclo/auto_standard/auto_confort); the '
  'real category labels are confirmed during Phase 0 reconnaissance and edited here.';

ALTER TABLE public.competitor_category_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS competitor_category_map_admin_read ON public.competitor_category_map;
CREATE POLICY competitor_category_map_admin_read
  ON public.competitor_category_map FOR SELECT USING (public.is_admin());

DROP POLICY IF EXISTS competitor_category_map_super_admin_write ON public.competitor_category_map;
CREATE POLICY competitor_category_map_super_admin_write
  ON public.competitor_category_map FOR ALL
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. competitor_quotes — the captured time series
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.competitor_quotes (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  route_id              uuid NOT NULL REFERENCES public.competitor_routes(id) ON DELETE CASCADE,
  competitor            text NOT NULL CHECK (competitor IN ('la_nave', 'cinco')),
  captured_at           timestamptz NOT NULL DEFAULT now(),
  competitor_price_cup  integer,               -- NULL = unavailable / unreadable this cycle
  competitor_category   text,                  -- their category we matched
  tricigo_price_cup     integer NOT NULL,      -- what TriciGo would charge, same route, same instant
  tricigo_service_type  text NOT NULL,
  exchange_rate_usd_cup numeric,               -- FX in effect at capture (audits our own price)
  weather_surge         numeric,               -- our weather surge in effect (audits our own price)
  raw                   jsonb,                 -- trimmed competitor response (debug), price/category only, NO PII
  CONSTRAINT competitor_price_nonneg CHECK (competitor_price_cup IS NULL OR competitor_price_cup >= 0),
  CONSTRAINT tricigo_price_nonneg   CHECK (tricigo_price_cup >= 0)
);

COMMENT ON TABLE public.competitor_quotes IS
  '00587: every captured competitor quote, paired with TriciGo''s own price for the '
  'same route in the same 15-min cycle (that pairing is the whole point — our tariff '
  'moves hourly with FX). Lock table for writes: only the capturing EF (service_role) '
  'inserts; admins can read for the panel. competitor_price_cup NULL = not available '
  'that cycle (valid datum, not an error). raw holds price/category only, never PII.';

CREATE INDEX IF NOT EXISTS competitor_quotes_series_idx
  ON public.competitor_quotes (route_id, competitor, captured_at DESC);
CREATE INDEX IF NOT EXISTS competitor_quotes_captured_at_idx
  ON public.competitor_quotes (captured_at DESC);

ALTER TABLE public.competitor_quotes ENABLE ROW LEVEL SECURITY;

-- Admin read (the panel). NO write policy → tamper-proof; only the EF via
-- service_role (which bypasses RLS) inserts. A FOR SELECT policy does not grant
-- writes.
DROP POLICY IF EXISTS competitor_quotes_admin_read ON public.competitor_quotes;
CREATE POLICY competitor_quotes_admin_read
  ON public.competitor_quotes FOR SELECT USING (public.is_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. competitor_sessions — the deposited session credential, one row per competitor
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.competitor_sessions (
  competitor  text PRIMARY KEY CHECK (competitor IN ('la_nave', 'cinco')),
  credential  text NOT NULL,                   -- the competitor's session token/cookie
  expires_at  timestamptz,                     -- when it stops working (from Phase 0); NULL if unknown
  updated_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz,                     -- last time a quote succeeded with this credential
  status      text NOT NULL DEFAULT 'unknown' CHECK (status IN ('ok', 'expired', 'unknown'))
);

COMMENT ON TABLE public.competitor_sessions IS
  '00587: session credential the owner''s phone deposits per competitor, so the EF '
  'can quote as a logged-in user. LOCK TABLE: RLS on, ZERO policies — nobody reads it '
  'via PostgREST, not even admin. The EF reads it with service_role; the phone deposits '
  'via deposit-competitor-session (admin-authenticated). '
  'DELIBERATELY NOT stored in platform_config: platform_config_is_secret() (mig 00517) '
  'classifies secrets by NAME SUFFIX (_token/_secret/…); a credential there under the '
  'wrong name would be served to anon. A dedicated lock table is immune to that.';

ALTER TABLE public.competitor_sessions ENABLE ROW LEVEL SECURITY;
-- No policies on purpose. service_role bypasses RLS; everyone else sees nothing.

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Seed the category map from PR #965 observations
--    (real labels confirmed in Phase 0; edit competitor_category_map then).
--    Both competitors show the same 4 vehicle tiers in their estimate screen.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.competitor_category_map (competitor, competitor_category, tricigo_service_type) VALUES
  ('la_nave', 'moto',     'moto_standard'),
  ('la_nave', 'basico',   'triciclo_basico'),
  ('la_nave', 'standard', 'auto_standard'),
  ('la_nave', 'confort',  'auto_confort'),
  ('cinco',   'moto',     'moto_standard'),
  ('cinco',   'basico',   'triciclo_basico'),
  ('cinco',   'standard', 'auto_standard'),
  ('cinco',   'confort',  'auto_confort')
ON CONFLICT (competitor, competitor_category) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Seed the route basket — Havana-dense + provincial capitals.
--    distance_m/duration_s left NULL here; the seeding step (or a one-shot with
--    routing_google_enabled temporarily on) fills them. The EF skips routes with
--    NULL geometry (can't price them) so a half-seeded basket degrades safely.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.competitor_routes (label, province, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng) VALUES
  ('Vedado ↔ Habana Vieja',        'La Habana', 23.1360, -82.3830, 23.1400, -82.3520),
  ('Aeropuerto ↔ Vedado',          'La Habana', 22.9892, -82.4092, 23.1360, -82.3830),
  ('Playa ↔ Centro Habana',        'La Habana', 23.1050, -82.4300, 23.1390, -82.3660),
  ('Marianao ↔ Vedado',            'La Habana', 23.0850, -82.4340, 23.1360, -82.3830),
  ('Habana Vieja ↔ Miramar',       'La Habana', 23.1400, -82.3520, 23.1180, -82.4260),
  ('Vedado ↔ Nuevo Vedado',        'La Habana', 23.1360, -82.3830, 23.1170, -82.4000),
  ('Centro Habana ↔ Cerro',        'La Habana', 23.1390, -82.3660, 23.1050, -82.3760),
  ('Diez de Octubre ↔ Vedado',     'La Habana', 23.0900, -82.3600, 23.1360, -82.3830),
  ('Boyeros ↔ Plaza',              'La Habana', 23.0000, -82.3900, 23.1330, -82.3860),
  ('Guanabacoa ↔ Habana Vieja',    'La Habana', 23.1220, -82.3000, 23.1400, -82.3520),
  ('Santiago centro ↔ Vista Alegre','Santiago de Cuba', 20.0210, -75.8290, 20.0090, -75.8180),
  ('Camagüey centro ↔ La Caridad', 'Camagüey',  21.3800, -77.9170, 21.3900, -77.9080),
  ('Holguín centro ↔ Pueblo Nuevo','Holguín',   20.8870, -76.2630, 20.8990, -76.2560),
  ('Santa Clara centro ↔ periferia','Villa Clara', 22.4070, -79.9640, 22.4200, -79.9500)
ON CONFLICT (label) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Panel-read RPCs live in 00589 (with the watchdog). Tunables live in 00588
--    (with the cron). This migration is data-model only.
-- ─────────────────────────────────────────────────────────────────────────────
