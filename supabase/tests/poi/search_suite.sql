-- supabase/tests/poi/search_suite.sql — 60 real Cuban queries with the expected
-- top-1 (regex on lower(unaccent(name))) + 20 no-change controls (top-1 id must
-- equal search_pois_smart_v1's). Run against the REAL-DATA database (the
-- 19,939 active prod rows exported read-only, see CLAUDE.md § POIs):
--   psql -d poi_real -v fn=search_pois_smart -f supabase/tests/poi/search_suite.sql
-- The same file with -v fn=<candidate> is the A/B pattern of CLAUDE.md
-- ("candidata con otro nombre"). Expectations are display names AFTER 00579.
\pset format aligned
\pset footer off
WITH cases(n, q, lat, lng, expect) AS (VALUES
  -- Havana landmarks by name / bare name (origin: Capitolio 23.1357,-82.3666)
  ( 1, 'capitolio',                23.1357, -82.3666, '^(el )?capitolio'),
  ( 2, 'hotel nacional',           23.1357, -82.3666, '^hotel nacional de cuba'),
  ( 3, 'habana libre',             23.1357, -82.3666, '^hotel habana libre'),
  ( 4, 'coppelia',                 23.1357, -82.3666, '^coppelia'),
  ( 5, 'bodeguita',                23.1357, -82.3666, 'bodeguita del medio'),
  ( 6, 'floridita',                23.1357, -82.3666, '^(el )?floridita'),
  ( 7, 'fabrica de arte',          23.1357, -82.3666, 'fabrica de arte'),
  ( 8, 'fac',                      23.1357, -82.3666, 'fabrica de arte'),
  ( 9, 'ameijeiras',               23.1357, -82.3666, '^hospital hermanos ameijeiras'),
  (10, 'calixto garcia',           23.1357, -82.3666, 'calixto garcia'),
  (11, 'la benefica',              23.1357, -82.3666, 'miguel enriquez'),
  (12, 'cementerio de colon',      23.1357, -82.3666, 'cementerio de colon'),
  (13, 'ciudad deportiva',         23.1357, -82.3666, 'ciudad deportiva'),
  (14, 'karl marx',                23.1357, -82.3666, '^teatro karl marx'),
  (15, 'cuatro caminos',           23.1357, -82.3666, '4 caminos|cuatro caminos'),
  (16, 'manzana de gomez',         23.1357, -82.3666, 'kempinski|manzana'),
  (17, 'oncologico',               23.1357, -82.3666, 'oncologic'),
  (18, 'la cabaña',                23.1357, -82.3666, 'cabana'),
  (19, 'tropicana',                23.1357, -82.3666, 'tropicana'),
  (20, 'terminal de omnibus',      23.1357, -82.3666, 'terminal de omnibus'),
  (21, 'aeropuerto jose marti',    23.1357, -82.3666, 'jose marti'),
  (22, 'parque lenin',             23.1357, -82.3666, '^parque lenin'),
  (23, 'plaza de la revolucion',   23.1357, -82.3666, 'plaza de la revolucion'),
  (24, 'castillo del morro',       23.1357, -82.3666, 'morro'),
  (25, 'plaza vieja',              23.1357, -82.3666, '^plaza vieja'),
  (26, 'catedral de la habana',    23.1357, -82.3666, 'catedral'),
  (27, 'museo de la revolucion',   23.1357, -82.3666, '^museo de la revolucion'),
  (28, 'gran teatro',              23.1357, -82.3666, 'gran teatro'),
  (29, 'estadio latinoamericano',  23.1357, -82.3666, 'latinoamericano'),
  (30, 'universidad de la habana', 23.1357, -82.3666, '^universidad de la habana'),
  (31, 'hospital naval',           23.1357, -82.3666, 'naval'),
  (32, 'hospital militar',         23.1357, -82.3666, 'militar'),
  (33, 'cira garcia',              23.1357, -82.3666, 'cira garcia'),
  (34, 'la lonja',                 23.1357, -82.3666, 'lonja del comercio'),
  (35, 'maternidad de linea',      23.1357, -82.3666, 'america arias'),
  (36, 'la ceguera',               23.1357, -82.3666, 'pando ferrer'),
  (37, 'malecon',                  23.1357, -82.3666, 'malecon'),
  (38, 'plaza de armas',           23.1357, -82.3666, '^plaza de armas'),
  (39, 'callejon de hamel',        23.1357, -82.3666, 'hamel'),
  (40, 'hotel inglaterra',         23.1357, -82.3666, '^hotel inglaterra'),
  -- typos / accents / prefixes
  (41, 'copelia',                  23.1357, -82.3666, '^coppelia'),
  (42, 'capitolio nacional',       23.1357, -82.3666, 'capitolio'),
  (43, 'hosp calixto',             23.1357, -82.3666, 'calixto garcia'),
  (44, 'hotel habana lib',         23.1357, -82.3666, '^hotel habana libre'),
  (45, 'teatro karl',              23.1357, -82.3666, '^teatro karl marx'),
  -- other provinces (origin = the city centre)
  (46, 'casa granda',              20.0197, -75.8283, 'casa granda'),
  (47, 'santa ifigenia',           20.0197, -75.8283, 'santa ifigenia'),
  (48, 'cuartel moncada',          20.0197, -75.8283, 'moncada'),
  (49, 'parque cespedes',          20.0197, -75.8283, 'cespedes'),
  (50, 'mausoleo del che',         22.4069, -79.9649, 'che'),
  (51, 'teatro tomas terry',       22.1461, -80.4358, 'terry'),
  (52, 'plaza del carmen',         21.3808, -77.9169, 'carmen'),
  (53, 'loma de la cruz',          20.8872, -76.2631, 'loma de la cruz'),
  (54, 'teatro sauto',             23.0511, -81.5775, 'sauto'),
  (55, 'plaza mayor',              21.8042, -79.9840, 'plaza mayor'),
  (56, 'hotel internacional',      23.1394, -81.2861, 'internacional'),
  (57, 'aeropuerto de varadero',   23.1394, -81.2861, 'varadero|juan gualberto'),
  (58, 'hospital pediatrico',      22.4069, -79.9649, 'pediatric'),
  (59, 'universidad de oriente',   20.0197, -75.8283, 'universidad de oriente'),
  (60, 'terminal de trenes',       23.1357, -82.3666, 'ferrocarril|estacion central|terminal')
), run AS (
  -- to_jsonb so the same file runs against v1 (which has no matched_alias column)
  SELECT c.n, c.q, c.expect, r.id, r.name AS top1, r.match_reason, to_jsonb(r)->>'matched_alias' AS matched_alias, round(r.distance_m) AS dist_m
  FROM cases c
  LEFT JOIN LATERAL (SELECT * FROM :fn(c.q, c.lat, c.lng, 30000, 5) LIMIT 1) r ON true
)
SELECT n, q, left(top1, 44) AS top1, match_reason AS reason, left(matched_alias, 18) AS alias, dist_m,
       (lower(unaccent(COALESCE(top1, ''))) ~ expect) AS ok
FROM run ORDER BY n;

-- No-change controls: 20 plain queries whose top-1 must be the same POI in v1 and v2.
WITH ctl(q, lat, lng) AS (VALUES
  ('farmacia',        23.1357, -82.3666), ('panaderia',        23.1357, -82.3666),
  ('cadeca',          23.1357, -82.3666), ('etecsa',           23.1357, -82.3666),
  ('cupet',           23.1357, -82.3666), ('policlinico',      23.1357, -82.3666),
  ('iglesia',         23.1357, -82.3666), ('escuela',          23.1357, -82.3666),
  ('banco metropolitano', 23.1357, -82.3666), ('agromercado',   23.1357, -82.3666),
  ('cine yara',       23.1357, -82.3666), ('cine 23 y 12',     23.1357, -82.3666),
  ('hotel sevilla',   23.1357, -82.3666), ('hotel saratoga',   23.1357, -82.3666),
  ('paladar la guarida', 23.1357, -82.3666), ('museo de bellas artes', 23.1357, -82.3666),
  ('parque almendares', 23.1357, -82.3666), ('playa santa maria', 23.1357, -82.3666),
  ('hotel melia cohiba', 23.1357, -82.3666), ('estadio pedro marrero', 23.1357, -82.3666)
)
SELECT c.q, left(v1.name, 40) AS v1_top, left(v2.name, 40) AS v2_top, (v1.id = v2.id) AS same
FROM ctl c
LEFT JOIN LATERAL (SELECT id, name FROM search_pois_smart_v1(c.q, c.lat, c.lng, 30000, 1)) v1 ON true
LEFT JOIN LATERAL (SELECT id, name FROM :fn(c.q, c.lat, c.lng, 30000, 1)) v2 ON true
ORDER BY c.q;
