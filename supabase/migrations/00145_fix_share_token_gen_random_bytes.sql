-- ============================================================
-- Migration 00145: qualify gen_random_bytes in share_token trigger
--
-- `generate_share_token_on_accept` (BEFORE UPDATE on rides when
-- status: searching → accepted) calls gen_random_bytes(12) without
-- schema prefix. pgcrypto installs the function in the `extensions`
-- schema (not `public`), so any invocation from a function with a
-- restricted search_path — e.g. accept_ride_v2 which does
-- `SET search_path = public, pg_catalog` — fails with 42883:
-- `function gen_random_bytes(integer) does not exist`.
--
-- This was masked by migration 00121 whose earlier trigger
-- (enforce_ride_update_columns, fixed in 00144) aborted the
-- transaction BEFORE this AFTER-trigger fired. Now that the
-- driver_id guard lets legitimate accepts through, the share
-- token trigger runs and hits the missing symbol.
--
-- Minimal, surgical fix: qualify the call explicitly.
-- ============================================================

CREATE OR REPLACE FUNCTION public.generate_share_token_on_accept()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status = 'accepted' AND OLD.status = 'searching' AND NEW.share_token IS NULL THEN
    NEW.share_token := encode(extensions.gen_random_bytes(12), 'hex');
  END IF;
  RETURN NEW;
END;
$function$;
