-- ============================================================================
-- supabase/tests/poi/scaffold.sql — local rehearsal environment for the POI
-- migrations (00579 / 00580 / 00581). Loaded into a throwaway Postgres 16 +
-- PostGIS database by run.sh. NOT a migration. Never run against prod.
--
-- What it reproduces from prod (captured 2026-09-05 with pg_get_functiondef):
--   * the real DDL subset of cuba_pois (all 31 columns, the GENERATED
--     name_normalized column, the trgm/GIST indexes and the 5 row triggers)
--   * cuba_admin_areas, cuba_search_keywords, cuba_pois_submissions
--   * the LIVE bodies of the functions the migrations patch or depend on:
--     admin_create_poi, admin_update_poi, approve_poi_submission,
--     import_search_poi, find_nearby_poi_match, map_category_to_tricigo,
--     tg_pois_default_tricigo_category, compute_poi_importance (both
--     overloads), is_cuban_brand_match, the address/importance/updated_at/
--     geofence trigger functions and _poi_point_in_cuba.
--   * auth.uid() / auth.role() / is_admin() shims, cuba_landmask as one bbox.
-- Fixture rows at the bottom cover every class the tests need (Swedish
-- descriptor, city suffix, ALL-CAPS acronym, lowercase, exact duplicates 20 m
-- apart across sources, a bus stop named like a hospital, an admin row, a
-- Wikidata row, a CUPET row with tags->>'brand', garbage provinces).
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ---------------------------------------------------------------- shims ----
CREATE SCHEMA IF NOT EXISTS auth;
-- Supabase roles referenced by the RLS policies / GRANTs the migrations create.
DO $$ BEGIN CREATE ROLE anon NOLOGIN;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;

-- Live body (prod): SELECT public.unaccent('public.unaccent', $1)
CREATE OR REPLACE FUNCTION public.immutable_unaccent(text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT public.unaccent('public.unaccent', $1);
$function$;

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role text NOT NULL DEFAULT 'customer',
  full_name text
);
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin','super_admin')) $$;

-- --------------------------------------------------------------- tables ----
CREATE TABLE public.cuba_admin_areas (
  id bigserial PRIMARY KEY,
  osm_id bigint NOT NULL,
  admin_level integer NOT NULL,
  name text NOT NULL,
  name_es text,
  iso_code text,
  parent_province_iso text,
  geom geometry NOT NULL,            -- prod holds a mix of Polygon / MultiPolygon, SRID 4326
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cuba_admin_areas_geom ON public.cuba_admin_areas USING gist (geom);

CREATE TABLE public.cuba_search_keywords (
  keyword text PRIMARY KEY,
  tricigo_category text NOT NULL,
  notes text
);

CREATE TABLE public.cuba_pois (
  id bigserial PRIMARY KEY,
  osm_id bigint,
  osm_type text DEFAULT 'node',
  name text NOT NULL,
  name_normalized text GENERATED ALWAYS AS (lower(public.immutable_unaccent(name))) STORED,
  category text,
  subcategory text,
  address text,
  city text,
  neighborhood text,
  location geography(Point,4326) NOT NULL,
  tags jsonb DEFAULT '{}'::jsonb,
  imported_at timestamptz DEFAULT now(),
  importance smallint DEFAULT 5,
  source text NOT NULL DEFAULT 'osm',
  source_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  tricigo_category text,
  phone text,
  website text,
  socials jsonb,
  hours text,
  confidence real DEFAULT 0.5,
  is_admin boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  province text,
  municipality text,
  synced_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  address_normalized text,
  footprint_radius_m smallint,
  UNIQUE (osm_id, osm_type)
);
CREATE INDEX idx_cuba_pois_name_trgm      ON public.cuba_pois USING gin (name_normalized gin_trgm_ops);
CREATE INDEX idx_cuba_pois_name_orig_trgm ON public.cuba_pois USING gin (name gin_trgm_ops);
CREATE INDEX idx_cuba_pois_location       ON public.cuba_pois USING gist (location);
CREATE INDEX idx_cuba_pois_name           ON public.cuba_pois USING btree (name);
CREATE INDEX idx_cuba_pois_tricigo_cat    ON public.cuba_pois USING btree (tricigo_category) WHERE is_active = true AND tricigo_category IS NOT NULL;
CREATE INDEX idx_cuba_pois_source_ids_gin ON public.cuba_pois USING gin (source_ids);
CREATE INDEX idx_cuba_pois_municipality_act ON public.cuba_pois USING btree (municipality) WHERE is_active = true;
CREATE INDEX idx_cuba_pois_address_trgm   ON public.cuba_pois USING gin (address_normalized gin_trgm_ops) WHERE address_normalized IS NOT NULL;

CREATE TABLE public.cuba_pois_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_by uuid NOT NULL DEFAULT '00000000-0000-0000-0000-00000000b001',
  name text NOT NULL,
  tricigo_category text NOT NULL,
  location geography(Point,4326) NOT NULL,
  address text,
  notes text,
  status text NOT NULL DEFAULT 'pending',
  moderator_id uuid,
  moderated_at timestamptz,
  rejection_reason text,
  promoted_poi_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitter_role text
);

-- Geofence dependency (00575). Prod carries the real landmask; here one bbox
-- so the trigger stays wired exactly like prod without a 20 MB polygon.
CREATE TABLE public.cuba_landmask (
  id serial PRIMARY KEY,
  geom geometry(Polygon,4326) NOT NULL
);
INSERT INTO public.cuba_landmask (geom) VALUES
  (ST_GeomFromText('POLYGON((-85.2 19.3,-73.8 19.3,-73.8 23.7,-85.2 23.7,-85.2 19.3))', 4326));
CREATE INDEX idx_cuba_landmask_geom ON public.cuba_landmask USING gist (geom);

-- ------------------------------------------------ live function bodies ----
CREATE OR REPLACE FUNCTION public._poi_point_in_cuba(p_point geography)
 RETURNS boolean
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.cuba_landmask m
    WHERE m.geom && ST_SetSRID(p_point::geometry, 4326)
      AND ST_Covers(m.geom, ST_SetSRID(p_point::geometry, 4326))
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_cuban_brand_match(p_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_brands TEXT[] := ARRAY[
    'cupet', 'oro negro',
    'etecsa', 'cubacel', 'nauta',
    'cimex', 'trd caribe', 'panamericana', 'caracol',
    'banco metropolitano', 'banco financiero internacional',
    'bandec', 'bpa', 'bicsa', 'banco popular de ahorro',
    'gran caribe', 'islazul', 'cubanacan', 'gaviota', 'sol melia',
    'iberostar', 'meliá', 'melia cohiba',
    'la guarida', 'el aljibe', 'la bodeguita', 'la imprenta',
    'el cocinero', 'la fontana', '5 esquinas',
    'el rapido', 'pain de paris', 'rumbos',
    'esicuba', 'esen',
    'farmacia internacional',
    'habana cafe', 'tropicana', 'casa de la musica'
  ];
  v_lower TEXT;
  v_brand TEXT;
BEGIN
  IF p_name IS NULL OR length(p_name) < 2 THEN
    RETURN FALSE;
  END IF;
  v_lower := lower(unaccent(p_name));
  FOREACH v_brand IN ARRAY v_brands LOOP
    IF position(v_brand IN v_lower) > 0 THEN
      RETURN TRUE;
    END IF;
  END LOOP;
  RETURN FALSE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.compute_poi_importance(p_tricigo_category text, p_is_admin boolean, p_website text, p_phone text, p_source text)
 RETURNS smallint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT GREATEST(1, LEAST(5,
    (CASE
      WHEN COALESCE(p_is_admin, false) THEN 1
      WHEN p_tricigo_category IN ('hospital','hotel','museum') THEN 2
      WHEN p_tricigo_category IN ('gov','school','embassy','bank','park',
                                  'beach','religion','supermarket','pharmacy',
                                  'gas_station') THEN 3
      WHEN p_tricigo_category IN ('restaurant','paladar','cafe','bar','atm',
                                  'shop','transport') THEN 4
      ELSE 5
    END)
    - (CASE
        WHEN NOT COALESCE(p_is_admin, false)
         AND ( p_source = 'merged'
            OR (p_website IS NOT NULL AND p_website <> '')
            OR (p_phone   IS NOT NULL AND p_phone   <> '') )
        THEN 1 ELSE 0 END)
  ))::smallint;
$function$;

CREATE OR REPLACE FUNCTION public.compute_poi_importance(p_poi cuba_pois)
 RETURNS smallint
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_base SMALLINT;
  v_has_wd BOOLEAN;
  v_brand BOOLEAN;
  v_high_conf BOOLEAN;
  v_has_contact BOOLEAN;
  v_paladar_crowd BOOLEAN;
  v_osm_only_bare BOOLEAN;
  v_score SMALLINT;
BEGIN
  IF COALESCE(p_poi.is_admin, FALSE) THEN
    RETURN 1::SMALLINT;
  END IF;

  v_has_wd := (p_poi.source_ids IS NOT NULL) AND (p_poi.source_ids ? 'wd');
  IF v_has_wd THEN
    RETURN 1::SMALLINT;
  END IF;

  v_base := CASE p_poi.tricigo_category
    WHEN 'hospital' THEN 2
    WHEN 'hotel' THEN 2
    WHEN 'museum' THEN 2
    WHEN 'gov' THEN 3
    WHEN 'school' THEN 3
    WHEN 'religion' THEN 3
    WHEN 'park' THEN 3
    WHEN 'beach' THEN 3
    WHEN 'bank' THEN 3
    WHEN 'pharmacy' THEN 3
    WHEN 'embassy' THEN 3
    WHEN 'transport' THEN 3
    WHEN 'gas_station' THEN 4
    WHEN 'supermarket' THEN 4
    WHEN 'restaurant' THEN 4
    WHEN 'paladar' THEN 4
    WHEN 'cafe' THEN 4
    WHEN 'bar' THEN 4
    WHEN 'shop' THEN 4
    WHEN 'atm' THEN 4
    ELSE 5
  END;

  v_brand := is_cuban_brand_match(p_poi.name);
  v_high_conf := COALESCE(p_poi.confidence, 0) >= 0.8;
  v_has_contact := (p_poi.phone IS NOT NULL AND p_poi.phone <> '')
                OR (p_poi.website IS NOT NULL AND p_poi.website <> '');
  v_paladar_crowd := p_poi.tricigo_category = 'paladar'
                  AND p_poi.source = 'crowdsource';

  v_score := v_base;
  IF v_brand THEN v_score := v_score - 1; END IF;
  IF v_high_conf THEN v_score := v_score - 1; END IF;
  IF v_has_contact THEN v_score := v_score - 1; END IF;
  IF p_poi.source = 'merged' THEN v_score := v_score - 1; END IF;
  IF v_paladar_crowd THEN v_score := v_score - 1; END IF;

  v_osm_only_bare := p_poi.source = 'osm' AND NOT v_has_contact;
  IF v_osm_only_bare THEN v_score := v_score + 1; END IF;

  RETURN GREATEST(1, LEAST(5, v_score))::SMALLINT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_cuba_pois_set_importance()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  NEW.importance := compute_poi_importance(NEW);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_cuba_pois_set_address_normalized()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  NEW.address_normalized := CASE
    WHEN NEW.address IS NULL OR NEW.address = '' THEN NULL
    ELSE lower(unaccent(NEW.address))
  END;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cuba_pois_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_cuba_pois_geofence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.location IS NULL OR public._poi_point_in_cuba(NEW.location) THEN
    RETURN NEW;
  END IF;

  RAISE LOG '00575 geofence: descartado POI fuera de Cuba: % (%, %) source=%',
    NEW.name,
    round(ST_Y(NEW.location::geometry)::numeric, 4),
    round(ST_X(NEW.location::geometry)::numeric, 4),
    NEW.source;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '00575 geofence fallo (% %) — dejando pasar %', SQLSTATE, SQLERRM, NEW.name;
  RETURN NEW;
END;
$function$;

-- map_category_to_tricigo: live body == migration 00302 (md5 asserted by 00581).
CREATE OR REPLACE FUNCTION public.map_category_to_tricigo(p_category text, p_subcategory text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  IF p_subcategory IS NOT NULL THEN
    CASE
      WHEN p_subcategory IN ('restaurant','fast_food','food_court','bakery') THEN RETURN 'restaurant';
      WHEN p_subcategory IN ('cafe','coffee','coffee_shop') THEN RETURN 'cafe';
      WHEN p_subcategory IN ('bar','pub','nightclub','dance_club') THEN RETURN 'bar';
      WHEN p_subcategory = 'paladar' THEN RETURN 'paladar';
      WHEN p_subcategory IN ('hotel','guest_house','hostel','apartment','motel','resort',
                              'casa_particular','holiday_rental_home') THEN RETURN 'hotel';
      WHEN p_subcategory IN ('supermarket','convenience','marketplace') THEN
        RETURN CASE WHEN p_subcategory = 'supermarket' THEN 'supermarket' ELSE 'shop' END;
      WHEN p_subcategory IN ('shop','clothes','electronics','jewelry','beauty','hairdresser',
                              'hair_salon','beauty_salon','mall','kiosk','mobile_phone') THEN RETURN 'shop';
      WHEN p_subcategory IN ('hospital','clinic','doctors','dentist','health_and_medical') THEN RETURN 'hospital';
      WHEN p_subcategory = 'pharmacy' THEN RETURN 'pharmacy';
      WHEN p_subcategory IN ('bank','bureau_de_change') THEN RETURN 'bank';
      WHEN p_subcategory = 'atm' THEN RETURN 'atm';
      WHEN p_subcategory IN ('school','university','college','kindergarten','education',
                              'college_university') THEN RETURN 'school';
      WHEN p_subcategory IN ('police','fire_station','townhall','courthouse','post_office',
                              'public_and_government_association','public_service_and_government',
                              'social_service_organizations','non_governmental_association',
                              'community_services_non_profits') THEN RETURN 'gov';
      WHEN p_subcategory IN ('embassy','consulate') THEN RETURN 'embassy';
      WHEN p_subcategory IN ('place_of_worship','church','synagogue','mosque',
                              'religious_organization','catholic_church','evangelical_church') THEN RETURN 'religion';
      WHEN p_subcategory IN ('museum','gallery','arts_centre','history_museum',
                              'cultural_center','arts_and_entertainment','arts_and_crafts',
                              'theatre','cinema','monument','attraction','artwork',
                              'topic_concert_venue','music_production') THEN
        RETURN CASE WHEN p_subcategory IN ('museum','history_museum','gallery') THEN 'museum' ELSE 'park' END;
      WHEN p_subcategory IN ('park','garden','playground','active_life','gym') THEN RETURN 'park';
      WHEN p_subcategory IN ('beach','coastal') THEN RETURN 'beach';
      WHEN p_subcategory IN ('fuel','gas_station') THEN RETURN 'gas_station';
      WHEN p_subcategory IN ('bus_station','bus_stop','taxi','ferry_terminal','aerodrome',
                              'aeroway','transportation','tours','travel_services','tourism') THEN RETURN 'transport';
      ELSE NULL;
    END CASE;
  END IF;

  IF p_category IS NOT NULL THEN
    CASE
      WHEN p_category IN ('restaurant','fast_food','food_court','bakery') THEN RETURN 'restaurant';
      WHEN p_category IN ('cafe','coffee','coffee_shop') THEN RETURN 'cafe';
      WHEN p_category IN ('bar','pub','nightclub','dance_club') THEN RETURN 'bar';
      WHEN p_category IN ('hotel','guest_house','hostel','apartment','motel','resort',
                          'casa_particular','holiday_rental_home') THEN RETURN 'hotel';
      WHEN p_category = 'supermarket' THEN RETURN 'supermarket';
      WHEN p_category IN ('shop','convenience','clothes','electronics','jewelry','beauty',
                          'hairdresser','hair_salon','beauty_salon','beauty_and_spa',
                          'mall','kiosk','mobile_phone','tattoo_and_piercing','arts_and_crafts',
                          'automotive_repair','motorcycle_repair','car_repair','real_estate',
                          'industrial_company','commercial_industrial','construction_services',
                          'printing_services','computer_hardware_company',
                          'it_service_and_computer_repair','public_utility_company',
                          'agriculture','media_news_company','event_planning','event_photography',
                          'gym','active_life') THEN RETURN 'shop';
      WHEN p_category IN ('hospital','clinic','doctors','dentist','health_and_medical') THEN RETURN 'hospital';
      WHEN p_category = 'pharmacy' THEN RETURN 'pharmacy';
      WHEN p_category IN ('bank','bureau_de_change') THEN RETURN 'bank';
      WHEN p_category = 'atm' THEN RETURN 'atm';
      WHEN p_category IN ('school','university','college','kindergarten','education',
                          'college_university') THEN RETURN 'school';
      WHEN p_category IN ('police','fire_station','townhall','courthouse','post_office',
                          'public_and_government_association','public_service_and_government',
                          'social_service_organizations','non_governmental_association',
                          'community_services_non_profits') THEN RETURN 'gov';
      WHEN p_category IN ('embassy','consulate') THEN RETURN 'embassy';
      WHEN p_category IN ('place_of_worship','church','synagogue','mosque',
                          'religious_organization','catholic_church','evangelical_church') THEN RETURN 'religion';
      WHEN p_category IN ('museum','gallery','arts_centre','history_museum',
                          'arts_and_entertainment','cultural_center','theatre','cinema',
                          'monument','attraction','artwork','topic_concert_venue',
                          'music_production') THEN
        RETURN CASE WHEN p_category IN ('museum','history_museum','gallery') THEN 'museum' ELSE 'park' END;
      WHEN p_category IN ('park','garden','playground') THEN RETURN 'park';
      WHEN p_category IN ('beach','coastal') THEN RETURN 'beach';
      WHEN p_category IN ('fuel','gas_station') THEN RETURN 'gas_station';
      WHEN p_category IN ('bus_station','bus_stop','taxi','ferry_terminal','aerodrome',
                          'aeroway','transportation','tours','travel_services','tourism') THEN RETURN 'transport';
      ELSE NULL;
    END CASE;

    IF p_category ILIKE 'travel and transportation%' THEN RETURN 'transport'; END IF;
    IF p_category ILIKE 'arts and entertainment > night club' THEN RETURN 'bar'; END IF;
    IF p_category ILIKE 'arts and entertainment%' THEN RETURN 'park'; END IF;
    IF p_category ILIKE 'food and dining%' THEN RETURN 'restaurant'; END IF;
    IF p_category ILIKE 'shopping%' THEN RETURN 'shop'; END IF;
    IF p_category ILIKE 'health%' THEN RETURN 'hospital'; END IF;
  END IF;

  RETURN 'other';
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_pois_default_tricigo_category()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.tricigo_category IS NULL THEN
    NEW.tricigo_category := public.map_category_to_tricigo(NEW.category, NEW.subcategory);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_create_poi(p_name text, p_tricigo_category text, p_lat double precision, p_lng double precision, p_address text DEFAULT NULL::text, p_municipality text DEFAULT NULL::text, p_province text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_hours text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE v_id BIGINT; v_name_norm TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin','super_admin')) THEN
    RAISE EXCEPTION 'forbidden: admin role required';
  END IF;
  IF length(trim(coalesce(p_name, ''))) = 0 THEN RAISE EXCEPTION 'name is required'; END IF;
  IF p_lat IS NULL OR p_lng IS NULL THEN RAISE EXCEPTION 'lat/lng are required'; END IF;
  IF p_lat < -90 OR p_lat > 90 OR p_lng < -180 OR p_lng > 180 THEN RAISE EXCEPTION 'lat/lng out of valid range'; END IF;
  v_name_norm := lower(unaccent(trim(p_name)));
  INSERT INTO cuba_pois (
    name, name_normalized, category, subcategory, tricigo_category,
    address, city, municipality, province,
    location, source, source_ids, phone, website, hours,
    confidence, is_admin, is_active, tags
  ) VALUES (
    trim(p_name), v_name_norm, 'admin', p_tricigo_category, p_tricigo_category,
    nullif(trim(coalesce(p_address, '')), ''),
    nullif(trim(coalesce(p_municipality, '')), ''),
    nullif(trim(coalesce(p_municipality, '')), ''),
    nullif(trim(coalesce(p_province, '')), ''),
    ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
    'admin', '{}'::jsonb,
    nullif(trim(coalesce(p_phone, '')), ''),
    nullif(trim(coalesce(p_website, '')), ''),
    nullif(trim(coalesce(p_hours, '')), ''),
    1.0, TRUE, TRUE, '{}'::jsonb
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_update_poi(p_id bigint, p_name text DEFAULT NULL::text, p_tricigo_category text DEFAULT NULL::text, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_address text DEFAULT NULL::text, p_municipality text DEFAULT NULL::text, p_province text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_hours text DEFAULT NULL::text, p_is_active boolean DEFAULT NULL::boolean, p_unlock_for_sync boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin','super_admin')) THEN
    RAISE EXCEPTION 'forbidden: admin role required';
  END IF;
  UPDATE cuba_pois SET
    name = COALESCE(NULLIF(trim(p_name), ''), name),
    name_normalized = CASE WHEN p_name IS NOT NULL AND length(trim(p_name)) > 0
                           THEN lower(unaccent(trim(p_name))) ELSE name_normalized END,
    tricigo_category = COALESCE(p_tricigo_category, tricigo_category),
    subcategory = COALESCE(p_tricigo_category, subcategory),
    address = CASE WHEN p_address IS NULL THEN address ELSE NULLIF(trim(p_address), '') END,
    city = CASE WHEN p_municipality IS NULL THEN city ELSE NULLIF(trim(p_municipality), '') END,
    municipality = CASE WHEN p_municipality IS NULL THEN municipality ELSE NULLIF(trim(p_municipality), '') END,
    province = CASE WHEN p_province IS NULL THEN province ELSE NULLIF(trim(p_province), '') END,
    phone = CASE WHEN p_phone IS NULL THEN phone ELSE NULLIF(trim(p_phone), '') END,
    website = CASE WHEN p_website IS NULL THEN website ELSE NULLIF(trim(p_website), '') END,
    hours = CASE WHEN p_hours IS NULL THEN hours ELSE NULLIF(trim(p_hours), '') END,
    location = CASE WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL
                    THEN ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography ELSE location END,
    is_active = COALESCE(p_is_active, is_active),
    is_admin = CASE WHEN p_unlock_for_sync THEN FALSE ELSE TRUE END,
    updated_at = NOW()
  WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'POI % not found', p_id; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.approve_poi_submission(p_submission_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id UUID;
  v_submission RECORD;
  v_new_poi_id BIGINT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL OR NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;

  SELECT * INTO v_submission
  FROM public.cuba_pois_submissions
  WHERE id = p_submission_id
    AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found_or_not_pending');
  END IF;

  INSERT INTO public.cuba_pois (
    name, name_normalized, tricigo_category, category, location,
    address, source, source_ids, is_admin, is_active, confidence,
    importance, synced_at, updated_at
  ) VALUES (
    v_submission.name,
    lower(unaccent(v_submission.name)),
    v_submission.tricigo_category,
    v_submission.tricigo_category,
    v_submission.location,
    v_submission.address,
    'crowdsource',
    jsonb_build_object('submission_id', v_submission.id::TEXT),
    FALSE,
    TRUE,
    0.7,
    3,
    NOW(),
    NOW()
  ) RETURNING id INTO v_new_poi_id;

  UPDATE public.cuba_pois_submissions
  SET status = 'approved',
      moderator_id = v_user_id,
      moderated_at = NOW(),
      promoted_poi_id = v_new_poi_id,
      updated_at = NOW()
  WHERE id = p_submission_id;

  RETURN jsonb_build_object(
    'success', TRUE,
    'promoted_poi_id', v_new_poi_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.find_nearby_poi_match(p_name text, p_lat double precision, p_lng double precision, p_radius_m integer DEFAULT 50)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_norm TEXT;
  v_id BIGINT;
BEGIN
  IF p_name IS NULL OR length(p_name) < 2 THEN
    RETURN NULL;
  END IF;

  v_norm := lower(unaccent(p_name));

  SELECT cp.id
  INTO v_id
  FROM public.cuba_pois cp
  WHERE cp.is_active
    AND cp.location IS NOT NULL
    AND ST_DWithin(
          cp.location,
          ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
          p_radius_m
        )
    AND cp.name_normalized IS NOT NULL
    AND similarity(cp.name_normalized, v_norm) >= 0.6
  ORDER BY similarity(cp.name_normalized, v_norm) DESC,
           ST_Distance(
             cp.location,
             ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
           ) ASC
  LIMIT 1;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.import_search_poi(p_name text, p_lat double precision, p_lng double precision, p_address text DEFAULT NULL::text, p_tricigo_category text DEFAULT 'other'::text, p_mapbox_id text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_website text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_existing_id BIGINT;
  v_is_admin BOOLEAN;
  v_existing_ids JSONB;
  v_new_id BIGINT;
  v_category TEXT;
BEGIN
  IF p_name IS NULL OR length(trim(p_name)) < 2 THEN
    RETURN jsonb_build_object('imported', FALSE, 'poi_id', NULL, 'reason', 'name_too_short');
  END IF;

  IF p_lat IS NULL OR p_lng IS NULL THEN
    RETURN jsonb_build_object('imported', FALSE, 'poi_id', NULL, 'reason', 'missing_coords');
  END IF;

  IF p_lat < 19.5 OR p_lat > 23.5 OR p_lng < -85.0 OR p_lng > -74.0 THEN
    RETURN jsonb_build_object('imported', FALSE, 'poi_id', NULL, 'reason', 'out_of_cuba');
  END IF;

  v_category := CASE
    WHEN p_tricigo_category IN (
      'hospital','hotel','museum','gov','school','religion','park',
      'beach','bank','pharmacy','embassy','transport','gas_station',
      'supermarket','restaurant','paladar','cafe','bar','shop','atm'
    ) THEN p_tricigo_category
    ELSE 'other'
  END;

  v_existing_id := public.find_nearby_poi_match(p_name, p_lat, p_lng, 50);

  IF v_existing_id IS NOT NULL THEN
    SELECT is_admin, source_ids
      INTO v_is_admin, v_existing_ids
    FROM public.cuba_pois
    WHERE id = v_existing_id;

    IF v_is_admin THEN
      RETURN jsonb_build_object('imported', FALSE, 'poi_id', v_existing_id, 'reason', 'admin_match');
    END IF;

    IF p_mapbox_id IS NOT NULL
       AND (v_existing_ids IS NULL OR NOT (v_existing_ids ? 'mapbox')) THEN
      UPDATE public.cuba_pois
      SET source_ids = COALESCE(source_ids, '{}'::jsonb)
                       || jsonb_build_object('mapbox', p_mapbox_id),
          updated_at = NOW()
      WHERE id = v_existing_id;
    END IF;

    RETURN jsonb_build_object('imported', FALSE, 'poi_id', v_existing_id, 'reason', 'duplicate_within_50m');
  END IF;

  -- name_normalized is GENERATED ALWAYS — Postgres populates it from name.
  INSERT INTO public.cuba_pois (
    name, tricigo_category, category, location, address,
    phone, website, source, source_ids, is_admin, is_active, confidence,
    importance, synced_at, updated_at
  ) VALUES (
    p_name,
    v_category,
    v_category,
    ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
    p_address,
    NULLIF(trim(p_phone), ''),
    NULLIF(trim(p_website), ''),
    'mapbox',
    CASE
      WHEN p_mapbox_id IS NOT NULL THEN jsonb_build_object('mapbox', p_mapbox_id)
      ELSE '{}'::jsonb
    END,
    FALSE,
    TRUE,
    0.8,
    4,
    NOW(),
    NOW()
  ) RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('imported', TRUE, 'poi_id', v_new_id, 'reason', 'inserted');
EXCEPTION
  WHEN unique_violation THEN
    v_existing_id := public.find_nearby_poi_match(p_name, p_lat, p_lng, 50);
    RETURN jsonb_build_object('imported', FALSE, 'poi_id', v_existing_id, 'reason', 'race_duplicate');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('imported', FALSE, 'poi_id', NULL, 'reason', 'error:' || SQLERRM);
END;
$function$;

-- ------------------------------------------------------ live triggers ----
CREATE TRIGGER cuba_pois_address_normalized_trg BEFORE INSERT OR UPDATE OF address ON public.cuba_pois FOR EACH ROW EXECUTE FUNCTION tg_cuba_pois_set_address_normalized();
CREATE TRIGGER tg_pois_default_tricigo_category_trg BEFORE INSERT OR UPDATE OF category, subcategory, tricigo_category ON public.cuba_pois FOR EACH ROW EXECUTE FUNCTION tg_pois_default_tricigo_category();
CREATE TRIGGER trg_cuba_pois_geofence BEFORE INSERT ON public.cuba_pois FOR EACH ROW EXECUTE FUNCTION tg_cuba_pois_geofence();
CREATE TRIGGER trg_cuba_pois_importance BEFORE INSERT OR UPDATE ON public.cuba_pois FOR EACH ROW EXECUTE FUNCTION tg_cuba_pois_set_importance();
CREATE TRIGGER trg_cuba_pois_updated_at BEFORE UPDATE ON public.cuba_pois FOR EACH ROW EXECUTE FUNCTION cuba_pois_set_updated_at();

-- ============================================================== fixtures ====
INSERT INTO public.users (id, role, full_name) VALUES
  ('00000000-0000-0000-0000-00000000a001', 'super_admin', 'Admin Prueba'),
  ('00000000-0000-0000-0000-00000000b001', 'customer',    'Pasajero Prueba');

-- Admin areas (prod polygons simplified: provinces 0.01°, municipalities 0.004°).
INSERT INTO public.cuba_admin_areas (osm_id, admin_level, name, name_es, iso_code, parent_province_iso, geom) VALUES
  (1854615, 4, 'La Habana', 'La Habana', 'CU-03', NULL,
   ST_GeomFromText('POLYGON((-82.3159513 23.3728348,-82.6072626 23.3079812,-82.5469245 23.0548325,-82.4919338 23.0749706,-82.4816287 23.032221,-82.5048418 23.0196625,-82.4993956 22.9998639,-82.4707366 22.9701798,-82.4436688 22.9875191,-82.4364451 22.9405264,-82.4195564 22.9510921,-82.3624513 22.9368677,-82.3561871 22.9656649,-82.2462042 22.9536444,-82.2613416 22.9781066,-82.1987133 22.9967542,-82.2271744 23.014648,-82.2257532 23.0638359,-82.1759242 23.0584354,-82.1470251 23.0808643,-82.1024597 23.0512717,-82.1143217 23.088452,-82.0932663 23.097181,-82.0959128 23.1190741,-82.0814213 23.1272549,-82.1067501 23.1613773,-82.0885035 23.3857728,-82.3159513 23.3728348))', 4326)),
  (2579313, 4, 'Mayabeque', 'Mayabeque', 'CU-16', NULL,
   ST_GeomFromText('POLYGON((-81.6465541 22.5705825,-82.1774142 22.4351479,-82.1751849 22.242778,-82.4106312 22.3451927,-82.4104101 22.6849917,-82.3952743 22.7346202,-82.4475968 22.747392,-82.4427367 22.7795053,-82.467387 22.7999328,-82.4565012 22.8158464,-82.4690367 22.853852,-82.4195564 22.9510921,-82.3814276 22.9337108,-82.3548548 22.940671,-82.3561871 22.9656649,-82.2462042 22.9536444,-82.2613416 22.9781066,-82.1987133 22.9967542,-82.2271744 23.014648,-82.2257532 23.0638359,-82.1759242 23.0584354,-82.1470251 23.0808643,-82.1024597 23.0512717,-82.1143217 23.088452,-82.0932663 23.097181,-82.0959128 23.1190741,-82.0814213 23.1272549,-82.1067501 23.1613773,-82.0885035 23.3857728,-81.6665189 23.415886,-81.6848054 23.1333547,-81.6691404 23.0631466,-81.6858079 23.0507124,-81.7063663 23.0648506,-81.7187115 23.0434688,-81.6986682 23.0245696,-81.7508273 22.9744525,-81.7133342 22.9732111,-81.6788906 22.9211165,-81.6956015 22.8402136,-81.641728 22.7818476,-81.6652026 22.7728754,-81.6675562 22.732217,-81.580862 22.6936394,-81.6115423 22.602672,-81.6465541 22.5705825))', 4326)),
  (5489813, 6, 'Centro Habana', 'Centro Habana', NULL, 'CU-03',
   ST_GeomFromText('POLYGON((-82.3784947 23.1432675,-82.3741804 23.1234369,-82.3664222 23.1239939,-82.3583439 23.1455484,-82.3784947 23.1432675))', 4326)),
  (5489824, 6, 'La Habana Vieja', 'La Habana Vieja', NULL, 'CU-03',
   ST_GeomFromText('POLYGON((-82.3664018 23.1138608,-82.3664222 23.1239939,-82.3572182 23.1468756,-82.3438394 23.1354412,-82.3588079 23.1234217,-82.358023 23.1188287,-82.3442432 23.1264302,-82.3506581 23.1106456,-82.3664018 23.1138608))', 4326)),
  (5489828, 6, 'Plaza de la Revolución', 'Plaza de la Revolución', NULL, 'CU-03',
   ST_GeomFromText('POLYGON((-82.4083541 23.1359576,-82.4118066 23.1214959,-82.4054098 23.1112871,-82.4120432 23.1042704,-82.4050414 23.0982542,-82.3866563 23.1132099,-82.3770529 23.1308904,-82.3777656 23.1438944,-82.3941527 23.1460468,-82.4083541 23.1359576))', 4326));

-- A slice of the prod keyword table (categories only; 00551 removed brands).
INSERT INTO public.cuba_search_keywords (keyword, tricigo_category) VALUES
  ('hospital','hospital'), ('policlinico','hospital'), ('farmacia','pharmacy'), ('parque','park'),
  ('playa','beach'), ('hotel','hotel'), ('servicentro','gas_station'), ('museo','museum'),
  ('escuela','school'), ('iglesia','religion'), ('terminal','transport'), ('cafeteria','cafe');

-- POIs. Column order: name, category, subcategory, tricigo_category, lat, lng,
-- source, confidence, source_ids, tags, is_admin, province, municipality, address
INSERT INTO public.cuba_pois (name, category, subcategory, tricigo_category, location, source, confidence, source_ids, tags, is_admin, province, municipality, address)
SELECT name, category, subcategory, tricigo_category,
       ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
       source, confidence, source_ids::jsonb, tags::jsonb, is_admin, province, municipality, address
FROM (VALUES
  -- 1. throwaway first row (T1a renames min(id) — keep the named fixtures out of its way)
  ('Cafetería Prueba Uno',           'cafe',         NULL,        NULL,        23.1380, -82.3700, 'osm',        0.70, '{"osm":"n1"}',                 '{}', false, 'La Habana', 'Centro Habana', 'Neptuno e/ Galiano y Águila'),
  -- 2. curated alias target (T4a/T4b)
  ('Hospital Miguel Enríquez',       'hospital',     NULL,        NULL,        23.1128, -82.3340, 'merged',     0.92, '{"osm":"n2","ovt":"o2"}',      '{"alt_name":"Hospital Docente Miguel Enríquez"}', false, 'La Habana', 'Diez de Octubre', 'Ramón Pintó'),
  -- 3. CUPET with brand tag, mis-categorised (T4c, T7f)
  ('Servicentro Cupet Malecón',      'shop',         NULL,        'other',     23.1445, -82.3790, 'overture',   0.85, '{"ovt":"o3"}',                 '{"brand":"Cupet"}', false, 'Ciudad de la Habana', 'Vedado', 'Malecón y Calle 23'),
  -- 4. CUPET by name only (regex path of 00581)
  ('Cupet Santa Catalina',           'shop',         NULL,        'other',     23.0990, -82.3690, 'foursquare', 0.80, '{"fsq":"f4"}',                 '{}', false, 'La Habana', 'Cerro', NULL),
  -- 5. dictionary fixture (T5)
  ('Hotel Habana Libre',             'hotel',        NULL,        NULL,        23.1401, -82.3866, 'merged',     0.95, '{"osm":"n5","ovt":"o5","fsq":"f5"}', '{"name:es":"Hotel Habana Libre","short_name":"Habana Libre"}', false, 'La Habana', 'Plaza de la Revolución', 'Calle L e/ 23 y 25'),
  -- 6/7. exact duplicates 20 m apart across sources (T7b-e)
  ('Coppelia',                       'cafe',         NULL,        NULL,        23.1397, -82.3849, 'merged',     0.77, '{"osm":"n6","fsq":"f6"}',      '{}', false, 'La Habana', 'Plaza de la Revolución', 'Calle 23 y L'),
  ('Coppelia',                       'cafe',         NULL,        NULL,        23.1399, -82.3849, 'overture',   0.90, '{"ovt":"o7"}',                 '{}', false, 'City of Havana', 'Vedado', NULL),
  -- 8. Swedish Wikidata descriptor imported as a landmark (T7a); province unknown on purpose
  ('Arroyo Guayabo (vattendrag i Kuba, Provincia de Holguín, lat 20,5, long -75,3)', 'landmark', NULL, 'other', 20.5000, -75.3000, 'overture', 0.65, '{"ovt":"o8","wd":"Q8"}', '{}', false, NULL, NULL, NULL),
  -- 9. bus stop named like a hospital (must lose the curated alias to the real hospital)
  ('Hospital Calixto García',        'public_transport', 'bus_stop', NULL,     23.1405, -82.3890, 'osm',        0.60, '{"osm":"n9"}',                 '{}', false, 'La Habana', 'Plaza de la Revolución', NULL),
  ('Hospital Universitario General Calixto García', 'hospital', NULL, NULL,    23.1403, -82.3893, 'osm',        0.80, '{"osm":"n10"}',                '{}', false, 'La Habana', 'Plaza de la Revolución', 'Avenida Universidad'),
  -- 11. admin row with footprint
  ('El Capitolio',                   'admin',        'gov',       'gov',       23.1353, -82.3592, 'admin',      1.00, '{}',                           '{}', true,  'La Habana', 'La Habana Vieja', 'Paseo del Prado'),
  -- 12. Wikidata row
  ('Museo Nacional de Bellas Artes', 'museum',       NULL,        NULL,        23.1381, -82.3565, 'overture',   0.95, '{"ovt":"o12","wd":"Q12"}',     '{}', false, 'La Habana', 'La Habana Vieja', 'Trocadero e/ Zulueta y Monserrate'),
  -- 13. theatre → v1 mapper says park, v2 says venue
  ('Teatro Karl Marx',               'theatre',      NULL,        NULL,        23.1220, -82.4109, 'osm',        0.75, '{"osm":"n13"}',                '{"alt_name":"Blanquita"}', false, 'La Habana', 'Playa', 'Avenida 1ra y 10'),
  -- 14. cinema → venue
  ('Cine Yara',                      'cinema',       NULL,        NULL,        23.1396, -82.3851, 'osm',        0.70, '{"osm":"n14"}',                '{}', false, 'La Habana', 'Plaza de la Revolución', 'Calle 23 y L'),
  -- 15. stadium → v1 other, v2 stadium (lowercase name too: T2f class)
  ('estadio latinoamericano',        'leisure',      'stadium',   NULL,        23.1213, -82.3782, 'overture',   0.80, '{"ovt":"o15"}',                '{}', false, 'La Habana', 'Cerro', 'Zequeira y Patria'),
  -- 16. ALL-CAPS long word (T2g class)
  ('ESTUDIO REY',                    'shop',         NULL,        NULL,        23.1300, -82.3650, 'foursquare', 0.60, '{"fsq":"f16"}',                '{}', false, 'La Habana', 'Centro Habana', NULL),
  -- 17. ALL-CAPS acronym (T2h class), brand match
  ('ETECSA',                         'shop',         'mobile_phone', NULL,     23.1348, -82.3610, 'osm',        0.70, '{"osm":"n17"}',                '{"brand":"ETECSA"}', false, 'La Habana', 'La Habana Vieja', 'Obispo'),
  -- 18. city suffix with commas (T2c class), garbage province (T6c)
  ('La Roca, La Habana, Cuba',       'restaurant',   NULL,        NULL,        23.1405, -82.3855, 'overture',   0.90, '{"ovt":"o18"}',                '{}', false, 'FL', 'Ciudad de la Habana', 'Calle 21 y M'),
  -- 19. city suffix without commas (T2d class), garbage province
  ('Casa Medina La Habana Cuba',     'guest_house',  NULL,        NULL,        23.1380, -82.3540, 'foursquare', 0.70, '{"fsq":"f19"}',                '{}', false, 'City of Havana', 'Havana', NULL),
  -- 20. brand-named paladar, garbage municipality
  ('Paladar La Guarida',             'restaurant',   'paladar',   NULL,        23.1386, -82.3703, 'merged',     0.93, '{"osm":"n20","fsq":"f20"}',    '{}', false, 'La Habana', 'Centro Habana ', 'Concordia 418'),
  -- 21. curly quotes (T2m class)
  ('B&B Boutique “Los Villanueva”',  'guest_house',  NULL,        NULL,        23.1350, -82.3620, 'foursquare', 0.60, '{"fsq":"f21"}',                '{}', false, 'La Habana', 'La Habana Vieja', NULL),
  -- 22. airport code in parentheses (T2k class), outside fixture provinces → province stays NULL
  ('Máximo Gómez Airport (AVI)',     'aeroway',      'aerodrome', NULL,        22.0270, -78.7896, 'overture',   0.85, '{"ovt":"o22"}',                '{}', false, NULL, NULL, NULL),
  -- 23. pharmacy brand
  ('Farmacia Internacional',         'pharmacy',     NULL,        NULL,        23.1412, -82.3830, 'osm',        0.80, '{"osm":"n23"}',                '{}', false, 'La Habana', 'Plaza de la Revolución', 'Calle 23 y N'),
  -- 24. Mayabeque row (province polygon only, no municipality polygon)
  ('Playa Jibacoa',                  'beach',        NULL,        NULL,        23.1650, -81.9600, 'osm',        0.70, '{"osm":"n24"}',                '{}', false, 'Матанзас', 'Santa Cruz del Norte', NULL),
  -- 25. more curated-alias targets
  ('Hospital Hermanos Ameijeiras',   'hospital',     NULL,        NULL,        23.1430, -82.3696, 'merged',     0.95, '{"osm":"n25","ovt":"o25"}',    '{"alt_name":"Hospital Ameijeiras"}', false, 'La Habana', 'Centro Habana', 'San Lázaro 701'),
  ('Universidad de La Habana',       'university',   NULL,        NULL,        23.1373, -82.3826, 'osm',        0.85, '{"osm":"n26"}',                '{}', false, 'La Habana', 'Plaza de la Revolución', 'Calle L y San Lázaro'),
  ('Parque Central',                 'park',         NULL,        NULL,        23.1381, -82.3590, 'osm',        0.75, '{"osm":"n27"}',                '{}', false, 'La Habana', 'La Habana Vieja', 'Prado y Neptuno'),
  ('Cabaret Tropicana',              'nightclub',    NULL,        NULL,        23.1049, -82.4302, 'merged',     0.90, '{"osm":"n28","fsq":"f28"}',    '{}', false, 'La Habana', 'Marianao', 'Calle 72 y 45'),
  -- 29. transport in Habana Vieja
  ('Estación Central de Ferrocarriles', 'railway', 'station',    NULL,        23.1280, -82.3530, 'osm',        0.80, '{"osm":"n29"}',                '{}', false, 'La Habana', 'La Habana Vieja', 'Egido y Arsenal'),
  -- 30. inactive row (must never enter the dictionary)
  ('POI Desactivado',                'shop',         NULL,        NULL,        23.1300, -82.3600, 'osm',        0.50, '{"osm":"n30"}',                '{}', false, 'La Habana', 'Centro Habana', NULL),
  -- 31/32. Foursquare rows the sync labelled "museum" because the 'landmark' keyword matched "Landmarks and Outdoors > …" first (prod: 77 beaches, 44 parks, 86 neighbourhoods)
  ('Playa Prueba Foursquare',        'Landmarks and Outdoors > Beach', NULL, 'museum', 23.1750, -82.2900, 'foursquare', 0.70, '{"fsq":"f31"}', '{}', false, 'La Habana', 'Habana del Este', NULL),
  ('Vedado',                         'Landmarks and Outdoors > States and Municipalities > Neighborhood', NULL, 'museum', 23.1390, -82.3830, 'foursquare', 0.70, '{"fsq":"f32"}', '{}', false, 'La Habana', 'Plaza de la Revolución', NULL)
) AS f(name, category, subcategory, tricigo_category, lat, lng, source, confidence, source_ids, tags, is_admin, province, municipality, address);

UPDATE public.cuba_pois SET is_active = false WHERE name = 'POI Desactivado';

-- Prod-id fixture for the curated reactivation of 00579 §D (the cabaret hidden by the
-- confidence gate), plus rows for the 00581 cleanup / merge rules.
INSERT INTO public.cuba_pois (id, name, category, subcategory, location, source, confidence, source_ids, is_active, province, municipality) VALUES
  (120847, 'Tropicana', 'amenity', 'nightclub', ST_SetSRID(ST_MakePoint(-82.4302, 23.1049),4326)::geography, 'osm', 0.5, '{"osm":"n120847"}', false, 'La Habana', 'Marianao');
INSERT INTO public.cuba_pois (name, category, subcategory, tricigo_category, location, source, confidence, source_ids, province, municipality) VALUES
  ('Cayo Prueba (ö i Kuba, Provincia de Villa Clara)', 'landmark', NULL, 'other', ST_SetSRID(ST_MakePoint(-82.30, 23.20),4326)::geography, 'overture', 0.65, '{"ovt":"o33","wd":"Q33"}', 'La Habana', NULL),
  ('Charco Prueba (gruva)',                            'landmark', NULL, 'other', ST_SetSRID(ST_MakePoint(-82.31, 23.19),4326)::geography, 'overture', 0.65, '{"ovt":"o34"}',            'La Habana', NULL),
  ('ร้านอาหารทดสอบ',                                    'restaurant', NULL, NULL,   ST_SetSRID(ST_MakePoint(-82.37, 23.13),4326)::geography, 'foursquare', 0.7, '{"fsq":"f35"}',           'La Habana', 'Centro Habana'),
  ('AV 959 HAV-LIM',                                  'other', NULL, NULL,        ST_SetSRID(ST_MakePoint(-82.41, 22.99),4326)::geography, 'foursquare', 0.7, '{"fsq":"f36"}',           'La Habana', 'Boyeros'),
  -- same name, different category, 20 m apart, neither transport → merged by rule (b)
  ('Radio Prueba',                                    'broadcasting', NULL, 'other',  ST_SetSRID(ST_MakePoint(-82.3650, 23.1330),4326)::geography, 'merged',   0.8, '{"osm":"n37"}', 'La Habana', 'Centro Habana'),
  ('Radio Prueba',                                    'museum', NULL, 'museum',       ST_SetSRID(ST_MakePoint(-82.3652, 23.1330),4326)::geography, 'overture', 0.7, '{"ovt":"o38"}', 'La Habana', 'Centro Habana'),
  -- a bus stop named after a hotel is NOT the hotel → never merged
  ('Hotel Prueba Deauville',                          'public_transport', 'bus_stop', NULL, ST_SetSRID(ST_MakePoint(-82.3660, 23.1400),4326)::geography, 'merged',     0.8, '{"osm":"n39"}', 'La Habana', 'Centro Habana'),
  ('Hotel Prueba Deauville',                          'hotel', NULL, NULL,            ST_SetSRID(ST_MakePoint(-82.3661, 23.1401),4326)::geography, 'foursquare', 0.7, '{"fsq":"f40"}', 'La Habana', 'Centro Habana');
UPDATE public.cuba_pois SET footprint_radius_m = 25 WHERE name = 'El Capitolio';
