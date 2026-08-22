-- ============================================================
-- Migration 00571: los Sugeridos dejan de ofrecer barrios pelados
--
-- WHY (medido contra prod, 2026-08-21, impersonando a un usuario real):
--   get_destination_suggestions devolvía para una cuenta de prueba:
--     "Vedado, La Habana" · "Centro Habana, La Habana" · "Habana Vieja, ..."
--   Barrios sin calle — inútiles como destino. Dos causas:
--   1. Cada celda de dropoffs elige como representante la dirección MÁS
--      RECIENTE. Un pin suelto cuyo reverse-geocode cayó al fallback
--      municipio-only (Bug 2a) pisa a direcciones específicas anteriores
--      de la misma celda.
--   2. El tier popular no filtra especificidad: una celda cuyo mejor texto
--      es "Barrio, Provincia" compite igual que una con calle y cruce.
--
--   Además el cliente COERCIONABA reason='popular' a 'frequent'
--   (suggestions.service KNOWN_REASONS), poniéndole estrella de "Frecuente"
--   a lugares donde el usuario jamás estuvo — arreglado en el mismo PR del
--   lado TS ampliando la unión PredictionReason.
--
--   Se EVALUÓ y DESCARTÓ un tercer tier de "landmarks" desde cuba_pois:
--   con is_admin+confidence>=0.9 salen casas particulares y cafés (medido:
--   "Mimosas", "Galy Cafe" como "Destacado"), y los landmarks de verdad ya
--   los muestra la sección Populares del cliente (presets por cercanía).
--   Duplicarlos aquí es ruido; una sección que se oculta sin datos es más
--   honesta que chips inventados.
--
-- ESPERADO TRAS APLICAR (medido 2026-08-21, no es un bug):
--   La seccion "Sugeridos" queda VACIA en el cliente. Las unicas 3 celdas
--   que alcanzaban el umbral de frecuencia en toda la plataforma eran
--   justamente los barrios pelados que esta migracion filtra ("Vedado",
--   "Centro Habana", "Habana Vieja"). La unica direccion especifica
--   repetida ("Lourdes e/ San Leonardo y Santa Beatriz, Vibora Park")
--   tiene 2 viajes y el tier popular pide 3.
--   Contexto: 28 viajes completados en total, 7 clientes. El umbral de 3
--   se dejo INTACTO por decision del usuario (2026-08-21): la seccion se
--   activara sola cuando la gente repita destinos de verdad. NO bajarlo
--   para "arreglar" el vacio -- el vacio es el resultado honesto con este
--   volumen, y el hueco visual ya lo llenan las categorias de busqueda,
--   los lugares aliados y los populares por cercania del cliente.
--
-- WHAT: CREATE OR REPLACE de get_destination_suggestions (00359/00360),
--   transcrito del cuerpo VIVO (pg_get_functiondef) con DOS cambios:
--   a) el representante de cada celda (personal y popular) prefiere la
--      dirección con señal de calle (dígito o " e/ ") y recién después la
--      más reciente;
--   b) popular_top exige especificidad: dígito, " e/ ", o >=3 segmentos.
--   Mismo shape de retorno, mismos grants (REPLACE preserva ACL).
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_destination_suggestions(
  p_user_id uuid,
  p_lat double precision DEFAULT NULL::double precision,
  p_lng double precision DEFAULT NULL::double precision,
  p_hour integer DEFAULT NULL::integer,
  p_limit integer DEFAULT 5
)
 RETURNS TABLE(address text, latitude double precision, longitude double precision, score double precision, reason text, source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
#variable_conflict use_column
DECLARE
  v_hour  int := COALESCE(p_hour, EXTRACT(hour FROM now() AT TIME ZONE 'America/Havana')::int);
  v_dow   int := EXTRACT(dow  FROM now() AT TIME ZONE 'America/Havana')::int;
  v_limit int := GREATEST(LEAST(COALESCE(p_limit, 5), 10), 1);
BEGIN
  IF p_user_id IS NULL OR NOT (COALESCE(auth.uid() = p_user_id, false) OR public.is_admin()) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH personal_cells AS (
    SELECT
      count(*)                                                    AS frequency,
      count(*) FILTER (
        WHERE EXTRACT(hour FROM r.created_at AT TIME ZONE 'America/Havana')::int = v_hour
      )                                                           AS hour_count,
      count(*) FILTER (
        WHERE EXTRACT(dow FROM r.created_at AT TIME ZONE 'America/Havana')::int = v_dow
      )                                                           AS day_count,
      max(r.created_at)                                           AS last_visited,
      avg(r.dropoff_lat)                                          AS lat,
      avg(r.dropoff_lng)                                          AS lng,
      -- 00571a: el texto con señal de calle representa a la celda aunque el
      -- último viaje haya caído al fallback municipio-only.
      (array_agg(r.dropoff_address ORDER BY
        (r.dropoff_address ~ '\d' OR r.dropoff_address LIKE '% e/ %') DESC,
        r.created_at DESC))[1]                                    AS addr
    FROM public.rides r
    WHERE r.customer_id = p_user_id
      AND r.status = 'completed'
      AND r.dropoff_lat IS NOT NULL
      AND r.dropoff_lng IS NOT NULL
      AND r.dropoff_address IS NOT NULL
    GROUP BY round(r.dropoff_lat::numeric, 3), round(r.dropoff_lng::numeric, 3)
  ),
  personal_top AS (
    SELECT
      pc.addr AS address,
      pc.lat,
      pc.lng,
      (pc.frequency * 2 + pc.hour_count * 5 + pc.day_count * 3
        + CASE WHEN pc.last_visited >= now() - interval '7 days'  THEN 3
               WHEN pc.last_visited >= now() - interval '30 days' THEN 1
               ELSE 0 END)::double precision AS score,
      CASE WHEN pc.day_count >= 2 AND pc.hour_count >= 2 THEN 'time_pattern'
           WHEN pc.hour_count >= 2                       THEN 'time_pattern'
           WHEN pc.frequency  >= 3                       THEN 'frequent'
           ELSE 'recent' END AS reason,
      'personal'::text AS source
    FROM personal_cells pc
    -- 00571c (segunda pasada, mismo día): la verja de especificidad aplica
    -- también al tier personal. Medido tras la primera aplicación: la cuenta
    -- con más viajes seguía recibiendo "Centro Habana, La Habana" como
    -- time_pattern — celdas cuyo MEJOR texto es un barrio pelado. Etiqueta
    -- que no dirige no se sugiere; la sección del cliente se oculta sola.
    WHERE (pc.addr ~ '\d' OR pc.addr LIKE '% e/ %'
           OR (length(pc.addr) - length(replace(pc.addr, ',', ''))) >= 2)
      AND (pc.frequency * 2 + pc.hour_count * 5 + pc.day_count * 3
        + CASE WHEN pc.last_visited >= now() - interval '7 days'  THEN 3
               WHEN pc.last_visited >= now() - interval '30 days' THEN 1
               ELSE 0 END) >= 3
    ORDER BY score DESC
    LIMIT v_limit
  ),
  popular_top AS (
    SELECT
      pc.addr AS address,
      pc.lat,
      pc.lng,
      pc.frequency::double precision AS score,
      'popular'::text AS reason,
      'popular'::text AS source
    FROM (
      SELECT
        (array_agg(r.dropoff_address ORDER BY
          (r.dropoff_address ~ '\d' OR r.dropoff_address LIKE '% e/ %') DESC,
          r.created_at DESC))[1] AS addr,
        avg(r.dropoff_lat) AS lat,
        avg(r.dropoff_lng) AS lng,
        count(*)           AS frequency
      FROM public.rides r
      WHERE r.status = 'completed'
        AND r.created_at >= now() - interval '90 days'
        AND r.dropoff_lat IS NOT NULL
        AND r.dropoff_lng IS NOT NULL
        AND r.dropoff_address IS NOT NULL
        AND (
          p_lat IS NULL OR p_lng IS NULL
          OR ST_DWithin(
               r.dropoff_location,
               ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
               15000
             )
        )
      GROUP BY round(r.dropoff_lat::numeric, 3), round(r.dropoff_lng::numeric, 3)
      HAVING count(*) >= 3
    ) pc
    -- 00571b: sugerir un destino exige una dirección que dirija. Dígito,
    -- cruce " e/ ", o al menos tres segmentos; "Barrio, Provincia" no pasa.
    WHERE (pc.addr ~ '\d' OR pc.addr LIKE '% e/ %'
           OR (length(pc.addr) - length(replace(pc.addr, ',', ''))) >= 2)
      AND NOT EXISTS (
        SELECT 1 FROM personal_top pt
        WHERE abs(pt.lat - pc.lat) < 0.0015
          AND abs(pt.lng - pc.lng) < 0.0015
      )
    ORDER BY pc.frequency DESC
    LIMIT v_limit
  )
  SELECT s.address, s.lat AS latitude, s.lng AS longitude, s.score, s.reason, s.source
  FROM (
    SELECT pt.address, pt.lat, pt.lng, pt.score, pt.reason, pt.source, 0 AS tier FROM personal_top pt
    UNION ALL
    SELECT pp.address, pp.lat, pp.lng, pp.score, pp.reason, pp.source, 1 AS tier FROM popular_top pp
  ) s
  ORDER BY s.tier, s.score DESC
  LIMIT v_limit;
END;
$function$;
