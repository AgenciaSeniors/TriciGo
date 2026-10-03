-- ─────────────────────────────────────────────────────────────────────────────
-- 00590 — Competitor observatory: freeze route geometry + fix CINCO categories
--
-- Two independent, data-only fixes for the price observatory shipped in 00587:
--
--   A) Route geometry. The 14 seeded competitor_routes shipped with
--      distance_m/duration_s = NULL, and track-competitor-prices filters out
--      routes with NULL geometry ("can't price them"), so EVERY cron run today
--      returns 502 no_priceable_routes. This freezes the geometry (distance_m /
--      duration_s) precomputed once via Mapbox Directions (mapbox/driving), the
--      same routing engine the TriciGo client uses to price a ride — so the
--      observatory compares like-for-like. Values are frozen literals on
--      purpose (see the competitor_routes comment in 00587).
--
--   B) CINCO categories. The category map in 00587 GUESSED CINCO's tiers as
--      moto/basico/standard/confort. Reconnaissance confirmed CINCO's four real
--      vehicle-type labels are Moto / Triciclo / Básico / Confort. This replaces
--      the four guessed CINCO rows with the real labels. La Nave's rows are left
--      untouched — its real labels were NOT confirmed (its app is Flutter and
--      did not expose readable traffic during reconnaissance), so guessing-less
--      is better than guessing-wrong there.
--
-- Idempotent: geometry UPDATEs match by unique label; the CINCO remap deletes
-- then re-inserts CINCO rows with ON CONFLICT DO NOTHING.
-- NOT applied to prod yet (MCP guard); the panel/EF tolerate the current state.
-- ─────────────────────────────────────────────────────────────────────────────

-- A) Freeze route geometry (distance_m in metres, duration_s in seconds).
UPDATE public.competitor_routes AS r
SET distance_m = g.distance_m,
    duration_s = g.duration_s
FROM (VALUES
  ('Vedado ↔ Habana Vieja',          4384,   754),
  ('Aeropuerto ↔ Vedado',            19471, 2795),
  ('Playa ↔ Centro Habana',          10079, 1243),
  ('Marianao ↔ Vedado',              12728, 1681),
  ('Habana Vieja ↔ Miramar',         11735, 1322),
  ('Vedado ↔ Nuevo Vedado',           3561,  649),
  ('Centro Habana ↔ Cerro',           4807,  942),
  ('Diez de Octubre ↔ Vedado',        6723, 1325),
  ('Boyeros ↔ Plaza',                16387, 2122),
  ('Guanabacoa ↔ Habana Vieja',      11766, 1552),
  ('Santiago centro ↔ Vista Alegre',  3190,  565),
  ('Camagüey centro ↔ La Caridad',    2499,  476),
  ('Holguín centro ↔ Pueblo Nuevo',   2028,  406),
  ('Santa Clara centro ↔ periferia',  3113,  516)
) AS g(label, distance_m, duration_s)
WHERE r.label = g.label;

-- B) Replace CINCO's guessed category map with the real vehicle-type labels.
DELETE FROM public.competitor_category_map WHERE competitor = 'cinco';

INSERT INTO public.competitor_category_map (competitor, competitor_category, tricigo_service_type) VALUES
  ('cinco', 'Moto',     'moto_standard'),
  ('cinco', 'Triciclo', 'triciclo_basico'),
  ('cinco', 'Básico',   'auto_standard'),
  ('cinco', 'Confort',  'auto_confort')
ON CONFLICT (competitor, competitor_category) DO NOTHING;
