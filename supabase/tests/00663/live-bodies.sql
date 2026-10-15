-- The live bodies 00663 patches, dumped from prod on 2026-10-15 with pg_get_functiondef.
-- run.sh (L1) checks every one against prod's md5(prosrc). Do not edit by hand: re-dump.
SET ROLE postgres;
CREATE OR REPLACE FUNCTION public.admin_incomplete_driver_signups()
 RETURNS TABLE(driver_profile_id uuid, user_id uuid, full_name text, phone text, signed_up_at timestamp with time zone, last_sign_in_at timestamp with time zone, docs_uploaded integer, missing_docs text[], rejected_docs text[], has_push boolean, contact_count integer, last_contact_at timestamp with time zone, last_contact_by text, last_contact_channel text, last_contact_note text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH req(doc_type, pos) AS (
    VALUES ('national_id', 1), ('selfie', 2), ('drivers_license', 3),
           ('vehicle_registration', 4), ('vehicle_photo', 5)
  ),
  base AS (
    SELECT dp.id, dp.user_id, u.full_name, u.phone, dp.created_at, au.last_sign_in_at
    FROM public.driver_profiles dp
    JOIN public.users u ON u.id = dp.user_id
    LEFT JOIN auth.users au ON au.id = dp.user_id
    WHERE dp.status = 'pending_verification'
      AND NOT coalesce(u.is_test, false)
  ),
  latest AS (
    SELECT DISTINCT ON (d.driver_id, d.document_type)
           d.driver_id, d.document_type::text AS doc_type, d.rejection_reason
    FROM public.driver_documents d
    WHERE d.driver_id IN (SELECT b.id FROM base b)
    ORDER BY d.driver_id, d.document_type, d.uploaded_at DESC NULLS LAST, d.id DESC
  ),
  contacts AS (
    SELECT DISTINCT ON (o.driver_profile_id)
           o.driver_profile_id, o.created_at, a.full_name AS by_name, o.channel, o.note,
           count(*) OVER (PARTITION BY o.driver_profile_id) AS n
    FROM public.driver_outreach_log o
    LEFT JOIN public.users a ON a.id = o.admin_id
    ORDER BY o.driver_profile_id, o.created_at DESC, o.id DESC
  )
  SELECT
    b.id,
    b.user_id,
    b.full_name,
    b.phone,
    b.created_at,
    b.last_sign_in_at,
    (SELECT count(*) FROM latest l JOIN req ON req.doc_type = l.doc_type
      WHERE l.driver_id = b.id AND l.rejection_reason IS NULL)::integer,
    coalesce((SELECT array_agg(req.doc_type ORDER BY req.pos) FROM req
      WHERE NOT EXISTS (SELECT 1 FROM latest l WHERE l.driver_id = b.id AND l.doc_type = req.doc_type)),
      '{}'::text[]),
    coalesce((SELECT array_agg(l.doc_type ORDER BY l.doc_type) FROM latest l
      WHERE l.driver_id = b.id AND l.rejection_reason IS NOT NULL), '{}'::text[]),
    EXISTS (SELECT 1 FROM public.user_devices ud WHERE ud.user_id = b.user_id),
    coalesce(c.n, 0)::integer,
    c.created_at,
    c.by_name,
    c.channel,
    c.note
  FROM base b
  LEFT JOIN contacts c ON c.driver_profile_id = b.id
  ORDER BY b.created_at DESC;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_list_pois(p_search text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_municipality text DEFAULT NULL::text, p_only_admin boolean DEFAULT false, p_only_active boolean DEFAULT true, p_page integer DEFAULT 0, p_page_size integer DEFAULT 50)
 RETURNS TABLE(id bigint, name text, category text, subcategory text, tricigo_category text, address text, municipality text, province text, latitude double precision, longitude double precision, source text, source_ids jsonb, phone text, website text, socials jsonb, hours text, confidence real, is_admin boolean, is_active boolean, importance smallint, synced_at timestamp with time zone, updated_at timestamp with time zone, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_search_pat TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = auth.uid()
      AND u.role IN ('admin','super_admin')
  ) THEN
    RAISE EXCEPTION 'forbidden: admin role required';
  END IF;
  v_search_pat := CASE WHEN p_search IS NULL OR length(trim(p_search)) < 2 THEN NULL
                       ELSE '%' || lower(unaccent(p_search)) || '%' END;
  RETURN QUERY
  WITH filtered AS (
    SELECT p.id, p.name, p.category, p.subcategory, p.tricigo_category,
      p.address, p.municipality, p.province,
      ST_Y(p.location::geometry) AS latitude, ST_X(p.location::geometry) AS longitude,
      p.source, p.source_ids, p.phone, p.website, p.socials, p.hours,
      p.confidence, p.is_admin, p.is_active, p.importance,
      p.synced_at, p.updated_at
    FROM cuba_pois p
    WHERE (NOT p_only_active OR p.is_active = TRUE)
      AND (NOT p_only_admin OR p.is_admin = TRUE)
      AND (p_category     IS NULL OR p.tricigo_category = p_category)
      AND (p_source       IS NULL OR p.source           = p_source)
      AND (p_municipality IS NULL OR p.municipality     = p_municipality)
      AND (v_search_pat IS NULL OR p.name_normalized ILIKE v_search_pat OR p.name ILIKE v_search_pat)
  ), counted AS (SELECT COUNT(*) AS total FROM filtered)
  SELECT f.id, f.name, f.category, f.subcategory, f.tricigo_category,
    f.address, f.municipality, f.province, f.latitude, f.longitude,
    f.source, f.source_ids, f.phone, f.website, f.socials, f.hours,
    f.confidence, f.is_admin, f.is_active, f.importance,
    f.synced_at, f.updated_at, counted.total
  FROM filtered f CROSS JOIN counted
  ORDER BY f.updated_at DESC
  OFFSET (p_page * p_page_size)
  LIMIT  p_page_size;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_auto_accept_rate(p_days_back integer DEFAULT 7)
 RETURNS TABLE(profit_level text, total bigint, accepted bigint, rejected bigint, accept_rate numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    properties->>'profit_level' as profit_level,
    COUNT(*)::bigint as total,
    COUNT(*) FILTER (WHERE event_type = 'driver_ride_auto_accepted')::bigint as accepted,
    COUNT(*) FILTER (WHERE event_type = 'driver_ride_rejected')::bigint as rejected,
    ROUND(
      COUNT(*) FILTER (WHERE event_type = 'driver_ride_auto_accepted')::numeric / NULLIF(COUNT(*), 0) * 100,
      1
    ) as accept_rate
  FROM public.validation_events
  WHERE event_type IN ('driver_ride_auto_accepted', 'driver_ride_rejected')
    AND created_at >= now() - (p_days_back || ' days')::interval
  GROUP BY properties->>'profit_level';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_auto_nav_rate(p_days_back integer DEFAULT 7)
 RETURNS TABLE(total bigint, triggered bigint, cancelled bigint, follow_rate numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    COUNT(*)::bigint as total,
    COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_triggered')::bigint as triggered,
    COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_cancelled')::bigint as cancelled,
    ROUND(
      COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_triggered')::numeric /
      NULLIF(COUNT(*) FILTER (WHERE event_type IN ('driver_auto_nav_triggered', 'driver_auto_nav_cancelled')), 0) * 100,
      1
    ) as follow_rate
  FROM public.validation_events
  WHERE event_type IN ('driver_auto_nav_triggered', 'driver_auto_nav_cancelled')
    AND created_at >= now() - (p_days_back || ' days')::interval;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_override_frequency(p_days_back integer DEFAULT 7, p_limit integer DEFAULT 20)
 RETURNS TABLE(driver_id uuid, total_overrides bigint, reject_count bigint, nav_cancel_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    driver_id,
    COUNT(*)::bigint as total_overrides,
    COUNT(*) FILTER (WHERE event_type = 'driver_ride_rejected')::bigint as reject_count,
    COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_cancelled')::bigint as nav_cancel_count
  FROM public.validation_events
  WHERE event_type IN ('driver_ride_rejected', 'driver_auto_nav_cancelled')
    AND created_at >= now() - (p_days_back || ' days')::interval
  GROUP BY driver_id
  ORDER BY total_overrides DESC
  LIMIT p_limit;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.list_poi_submissions(p_status text DEFAULT 'pending'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, submitted_by uuid, name text, tricigo_category text, lat double precision, lng double precision, address text, notes text, status text, submitter_role text, created_at timestamp with time zone, moderator_id uuid, moderated_at timestamp with time zone, rejection_reason text, promoted_poi_id bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    s.id, s.submitted_by, s.name, s.tricigo_category,
    ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
    s.address, s.notes, s.status, s.submitter_role, s.created_at,
    s.moderator_id, s.moderated_at, s.rejection_reason, s.promoted_poi_id
  FROM public.cuba_pois_submissions s
  WHERE (p_status = 'all' OR s.status = p_status)
  ORDER BY s.created_at DESC
  LIMIT LEAST(p_limit, 200)
  OFFSET p_offset;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_ticket_messages_client_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.is_admin() THEN
    RETURN NEW;
  END IF;
  NEW.is_admin := false;
  NEW.created_at := now();
  RETURN NEW;
END;
$function$
;

RESET ROLE;
