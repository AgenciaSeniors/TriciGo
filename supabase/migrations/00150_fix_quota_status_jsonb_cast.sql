-- ============================================================
-- Migration 00150: fix get_driver_quota_status JSONB cast
--
-- The function had:
--   (SELECT (value::TEXT)::NUMERIC FROM platform_config WHERE key='quota_deduction_rate')
-- `value::TEXT` on JSONB preserves the surrounding quotes when the
-- stored value is a JSON string — and our platform_config stores
-- `"0.15"` as a JSON string (jsonb_typeof='string'), so the TEXT
-- representation is literally `"0.15"` with quotes. ::NUMERIC then
-- raises 22P02 "invalid input syntax for type numeric".
--
-- Symptom in app: Billetera tab fires /rpc/get_driver_quota_status
-- and the request returns 400. The tab still renders (quota data is
-- optional), but the driver's quota info (grace trips, block state,
-- warning threshold) is missing from the UI.
--
-- Fix: use `value #>> '{}'` scalar-extraction, which strips quotes
-- from JSON string scalars (and is a no-op for JSON numbers). Same
-- idiom used in migrations 00145, 00148, 00149.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_driver_quota_status(p_driver_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $function$
  SELECT jsonb_build_object(
    'balance', 0,
    'total_recharged', 0,
    'warning_active', false,
    'grace_trips_remaining', 0,
    'blocked', false,
    'deduction_rate', COALESCE(
      (SELECT (value #>> '{}')::NUMERIC FROM platform_config WHERE key='quota_deduction_rate'),
      0.15
    )
  );
$function$;
