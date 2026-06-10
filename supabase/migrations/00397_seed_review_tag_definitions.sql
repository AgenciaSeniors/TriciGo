-- ============================================================================
-- 00397 — Seed review_tag_definitions + unique tag_key (A1-01)
-- ============================================================================
-- Audit 2026-06-10, finding A1-01: review_tag_definitions was EMPTY in prod
-- and the service queried columns that don't exist (direction/sentiment/
-- is_active/display_order vs the real applies_to/is_positive/sort_order), so
-- the dynamic review tags NEVER loaded and the apps always used their
-- hardcoded fallback chips. The service-side query fix lands in the same PR;
-- this migration seeds the table with EXACTLY the tag keys the apps already
-- ship as fallbacks (labels = the existing es/en i18n texts), so DB and UI
-- agree from day one and submitted tags can resolve tag_key → tag_id.
--
-- applies_to is the REVIEWEE type:
--   'driver'   → tags shown when a rider rates a driver (rider_to_driver)
--   'customer' → tags shown when a driver rates a rider (driver_to_rider)
--
-- Idempotent: unique index on tag_key + ON CONFLICT DO NOTHING. Re-running
-- never duplicates and never overwrites admin-edited labels.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uniq_review_tag_definitions_tag_key
  ON public.review_tag_definitions (tag_key);

INSERT INTO public.review_tag_definitions
  (tag_key, label_es, label_en, applies_to, is_positive, sort_order)
VALUES
  -- rider → driver, positive (client FALLBACK_POSITIVE_TAGS)
  ('clean_vehicle',         'Vehículo limpio',          'Clean vehicle',          'driver',   true,  10),
  ('great_conversation',    'Gran conversación',        'Great conversation',     'driver',   true,  20),
  ('expert_navigation',     'Navegación experta',       'Expert navigation',      'driver',   true,  30),
  ('smooth_driving',        'Manejo suave',             'Smooth driving',         'driver',   true,  40),
  ('went_above_and_beyond', 'Fue más allá',             'Went above and beyond',  'driver',   true,  50),
  -- rider → driver, negative (client FALLBACK_NEGATIVE_TAGS)
  ('dirty_vehicle',         'Vehículo sucio',           'Dirty vehicle',          'driver',   false, 10),
  ('unsafe_driving',        'Manejo inseguro',          'Unsafe driving',         'driver',   false, 20),
  ('rude_behavior',         'Comportamiento grosero',   'Rude behavior',          'driver',   false, 30),
  ('wrong_route',           'Ruta incorrecta',          'Wrong route',            'driver',   false, 40),
  ('long_wait',             'Espera larga',             'Long wait',              'driver',   false, 50),
  -- driver → rider, positive (driver FALLBACK_POSITIVE_TAGS)
  ('respectful',            'Respetuoso',               'Respectful',             'customer', true,  10),
  ('good_conversation',     'Buena conversación',       'Good conversation',      'customer', true,  20),
  ('on_time_pickup',        'Puntual en recogida',      'On time at pickup',      'customer', true,  30),
  ('pleasant_ride',         'Viaje agradable',          'Pleasant ride',          'customer', true,  40),
  -- driver → rider, negative (driver FALLBACK_NEGATIVE_TAGS)
  ('rude',                  'Grosero',                  'Rude',                   'customer', false, 10),
  ('left_mess',             'Dejó basura',              'Left a mess',            'customer', false, 20),
  ('late_pickup',           'Tarde en recogida',        'Late to pickup',         'customer', false, 30),
  ('unsafe_behavior',       'Comportamiento inseguro',  'Unsafe behavior',        'customer', false, 40),
  ('bad_directions',        'Malas indicaciones',       'Bad directions',         'customer', false, 50)
ON CONFLICT (tag_key) DO NOTHING;
