-- ============================================================
-- Migration 00318: Cuban-vernacular synonyms for search_pois_smart
--
-- Today (post 00255) cuba_search_keywords has 138 entries with good
-- mainstream Spanish coverage (hotel/restaurante/farmacia/...) and
-- some classic cubanismos (cupet, paladar, guagua, almendron,
-- agromercado, etecsa, coppelia, malecón). But there are gaps in
-- vernacular terms a Cuban user actually types and that today are
-- NOT detected as category-intent by the keyword matcher:
--
--   - chopin / chopping        → vernacular for hard-currency store
--   - tienda mn                → tiendas en moneda nacional
--   - fruteria / verduleria /
--     carniceria / pescaderia  → classic shop sub-types
--   - mercado agropecuario     → full term (only "agro" exists today)
--   - viazul / astro /
--     panataxi / transmetro    → transport company names
--   - taxi colectivo /
--     colectivo / gua-gua      → informal transport
--   - policia / pnr /
--     migracion / transito     → gov dependencies
--   - cardiocentro / oncologia/
--     psiquiatrico / etc.      → specialised hospitals
--   - pollo asado /
--     puesto de comida         → informal food spots
--   - salon del reino          → Kingdom Hall (JW)
--
-- This migration is INSERT-only with ON CONFLICT DO NOTHING so it's
-- safe to re-apply and never overwrites manually-edited rows. RPC
-- definition is NOT touched — search_pois_smart reads the table at
-- runtime so the new keywords take effect immediately after apply.
--
-- Word-prefix safety: the matcher uses
--   v_norm = keyword OR v_norm LIKE keyword || ' %'
-- which means single-word keys like `policia` only fire on `policia`
-- alone or `policia X` (e.g. `policia nacional`). A query like
-- `Calle Policia` would NOT fire because it doesn't start with
-- "policia ". This protects against false positives on street names
-- that share a word with the keyword.
-- ============================================================

INSERT INTO public.cuba_search_keywords (keyword, tricigo_category, notes) VALUES
  -- ── hospital (especializados) ──────────────────────────────
  ('materno infantil',    'hospital', 'CU: hospital materno-infantil'),
  ('materno',             'hospital', NULL),
  ('cardiocentro',        'hospital', 'CU: cardiac specialist hospital'),
  ('oncologia',           'hospital', NULL),
  ('psiquiatrico',        'hospital', NULL),
  ('siquiatrico',         'hospital', 'CU: alt spelling'),
  ('oftalmologico',       'hospital', NULL),

  -- ── shop (vocabulario cubano + tiendas especializadas) ─────
  ('chopin',              'shop',     'CU: vernacular for hard-currency store ("shopping")'),
  ('chopping',            'shop',     'CU: alt for chopin'),
  ('tienda mn',           'shop',     'CU: store priced in moneda nacional'),
  ('divisa',              'shop',     'CU: hard-currency store'),
  ('fruteria',            'shop',     NULL),
  ('verduleria',          'shop',     NULL),
  ('carniceria',          'shop',     NULL),
  ('pescaderia',          'shop',     NULL),

  -- ── supermarket ────────────────────────────────────────────
  ('mercado agropecuario','supermarket', 'CU: full term for agro'),
  ('agropecuario',        'supermarket', NULL),

  -- ── gas_station ────────────────────────────────────────────
  ('gasolina',            'gas_station', NULL),
  ('servi cupet',         'gas_station', 'CU: alt spelling of servicentro CUPET'),

  -- ── transport (empresas + informal) ────────────────────────
  ('viazul',              'transport', 'CU: tourist bus company'),
  ('astro',               'transport', 'CU: inter-province bus company'),
  ('panataxi',            'transport', 'CU: taxi company'),
  ('transmetro',          'transport', 'CU: urban bus company'),
  ('taxi colectivo',      'transport', 'CU: shared taxi'),
  ('colectivo',           'transport', 'CU: shared transport'),
  ('gua-gua',             'transport', 'CU: hyphenated variant of guagua'),

  -- ── bank ───────────────────────────────────────────────────
  ('caja de ahorro',      'bank',     'CU: savings bank'),

  -- ── gov (police + immigration + transit) ───────────────────
  ('policia',             'gov',      'CU: police station'),
  ('pnr',                 'gov',      'CU: Policia Nacional Revolucionaria'),
  ('migracion',           'gov',      'CU: immigration office'),
  ('migraciones',         'gov',      'CU: alt plural'),
  ('transito',            'gov',      'CU: policia de transito'),

  -- ── cafe ───────────────────────────────────────────────────
  ('pasteleria',          'cafe',     NULL),

  -- ── restaurant (informal) ──────────────────────────────────
  ('pollo asado',         'restaurant', 'CU: rotisserie chicken spots'),
  ('puesto de comida',    'restaurant', 'CU: informal food stand'),

  -- ── religion ───────────────────────────────────────────────
  ('salon del reino',     'religion', 'JW: Kingdom Hall')

ON CONFLICT (keyword) DO NOTHING;

COMMENT ON TABLE public.cuba_search_keywords IS
  'Spanish + Cuban-vernacular keywords mapped to tricigo_category. Used by search_pois_smart() to detect category intent. Editable by admin. Seeded by 00255 (138 entries) + 00318 (36 vernacular additions).';
