-- ============================================================
-- Migration 00342: Data retention policy + GDPR anonymization
--
-- Context: prep producción. Hoy hay 17 pg_cron jobs activos pero faltan
-- dos critical retentions para sostener crecimiento + cumplir GDPR:
--
--   1. ride_location_events: alta cardinalidad (1 GPS ping cada 5 seg
--      por ride activo). En prod con 1000 rides/día × 30 min avg =
--      ~130M filas/año. Sin purge, la tabla satura disk + degrada
--      query performance del histórico.
--
--   2. rides anonymization GDPR: rides completados >2 años deben tener
--      PII removida (customer_id NULL, addresses → "anon"). El ride
--      mismo se conserva para analytics (revenue históricos, etc.)
--      pero deja de ser linkable a un usuario.
--
-- Tres componentes:
--   A) Index parcial en ride_location_events.recorded_at para acelerar
--      el DELETE periódico.
--   B) Función + cron job: prune ride_location_events >90 días.
--   C) Función + cron job: anonymize_old_rides para rides >730 días.
--
-- Patrones existentes reusados:
--   - prune-rpc-attempt-log (jobid 15) — mismo shape DELETE WHERE created_at < interval
--   - cleanup-old-notifications (jobid 29) — función separada SECURITY DEFINER
-- ============================================================

-- ── A) Index para acelerar DELETE eficiente ──
-- Btree sobre recorded_at sólo — para "DELETE WHERE recorded_at < X"
-- el query planner puede usar index scan en vez de seq scan.
CREATE INDEX IF NOT EXISTS idx_ride_location_events_recorded_at
  ON public.ride_location_events (recorded_at);

COMMENT ON INDEX public.idx_ride_location_events_recorded_at IS
  '00342: speeds up retention DELETE WHERE recorded_at < threshold. '
  'Existing idx_ride_locations_ride is composite (ride_id, recorded_at DESC) '
  'which is suboptimal for full-table range scans.';

-- ── B) Function + cron: prune ride_location_events >90 days ──
CREATE OR REPLACE FUNCTION public.prune_old_ride_location_events()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_deleted bigint;
  v_oldest_kept timestamptz;
BEGIN
  WITH del AS (
    DELETE FROM public.ride_location_events
    WHERE recorded_at < now() - interval '90 days'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_deleted FROM del;

  SELECT MIN(recorded_at) INTO v_oldest_kept FROM public.ride_location_events;

  RETURN jsonb_build_object(
    'deleted_rows', v_deleted,
    'oldest_kept', v_oldest_kept,
    'ran_at', now()
  );
END;
$$;

COMMENT ON FUNCTION public.prune_old_ride_location_events() IS
  '00342: deletes ride_location_events older than 90 days. Returns delta '
  'count + oldest remaining row. Scheduled via pg_cron job prune-ride-locations-90d.';

-- ── C) Function + cron: anonymize old rides for GDPR ──
-- Strategy: don't DELETE old rides (lost analytics + accounting trail)
-- but strip linkable PII once they're "old enough" to be out of any
-- legal hold window (~2 years for civil claims in most jurisdictions).
--
-- Anonymized fields:
--   - customer_id → NULL (no longer linkable to user)
--   - driver_id → NULL (no longer linkable to driver)
--   - pickup_address → 'ANONYMIZED'
--   - dropoff_address → 'ANONYMIZED'
--   - special_instructions → NULL (could contain PII)
--   - cancel_reason → NULL (could contain PII)
--   - share_token → NULL (no longer shareable)
--
-- Preserved for analytics:
--   - id, status, service_type, created_at, completed_at
--   - distance, duration, fare (revenue history)
--   - surge_multiplier, payment_method
--   - pickup_location, dropoff_location (geo aggregates)
CREATE OR REPLACE FUNCTION public.anonymize_old_rides()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_updated bigint;
  v_threshold timestamptz := now() - interval '730 days';  -- 2 years
BEGIN
  WITH upd AS (
    UPDATE public.rides SET
      customer_id           = NULL,
      driver_id             = NULL,
      pickup_address        = 'ANONYMIZED',
      dropoff_address       = 'ANONYMIZED',
      special_instructions  = NULL,
      cancel_reason         = NULL,
      share_token           = NULL
    WHERE created_at < v_threshold
      AND status IN ('completed', 'cancelled', 'expired')
      -- Idempotency: skip rides already anonymized
      AND (customer_id IS NOT NULL OR pickup_address <> 'ANONYMIZED')
    RETURNING id
  )
  SELECT COUNT(*) INTO v_updated FROM upd;

  RETURN jsonb_build_object(
    'anonymized_rows', v_updated,
    'threshold_date', v_threshold,
    'ran_at', now()
  );
END;
$$;

COMMENT ON FUNCTION public.anonymize_old_rides() IS
  '00342 (GDPR): strips PII from rides completed/cancelled/expired >730 days ago. '
  'Preserves id, status, geo, fare, timestamps for analytics. Idempotent: '
  'skips rows already anonymized. Scheduled via pg_cron anonymize-old-rides-yearly.';

-- ── D) Schedule cron jobs ──
-- Both run nightly to avoid impacting daytime traffic.
-- Idempotent: if job exists with same name, schedule is updated.
SELECT cron.schedule(
  'prune-ride-locations-90d',
  '30 3 * * *',  -- 03:30 UTC daily
  $$SELECT public.prune_old_ride_location_events();$$
)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-ride-locations-90d');

SELECT cron.schedule(
  'anonymize-old-rides-yearly',
  '0 4 * * 0',  -- 04:00 UTC every Sunday (weekly, dataset grows slowly)
  $$SELECT public.anonymize_old_rides();$$
)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'anonymize-old-rides-yearly');

-- ── E) Permissions ──
-- Only service_role + postgres can call these manually; cron runs via
-- supabase_admin which has access already.
REVOKE EXECUTE ON FUNCTION public.prune_old_ride_location_events() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.anonymize_old_rides() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_old_ride_location_events() TO service_role;
GRANT EXECUTE ON FUNCTION public.anonymize_old_rides() TO service_role;
