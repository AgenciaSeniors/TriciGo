-- 00487_normalize_cuban_phone_accept_6_prefix.sql
-- (Renumbered from 00486 to avoid a filename collision with
--  00486_cancellation_reasons_foundation.sql that landed on master in parallel.
--  The function was already applied to prod via CREATE OR REPLACE, so this is a
--  git-only reorder — prod needs no re-apply.)
--
-- Accept the new Cuban mobile prefix 6 (ETECSA 63/64) in the canonical phone
-- normalizer. Since late 2023 every new Cuban SIM — prepaid or postpaid — is
-- assigned an 8-digit number starting with 63 or 64 (legacy numbers keep 5).
-- The bare-local branch only matched `^5\d{7}$`, so a number like `63234567`
-- fell through un-normalized (returned raw) and broke phone-based matching in
-- find_user_by_phone / find_recipient_for_recharge / trusted-contact & fleet
-- triggers — all of which delegate to this single helper.
--
-- Fix: the bare-local branch now matches `^[56]\d{7}$` (5 or 6). The country-code
-- branch (`^53\d{8}$`) was already prefix-agnostic, so the +53 / 53 forms already
-- worked. Body is otherwise VERBATIM from the live prod definition.
--
-- No backfill: prod currently has 0 users with a 6-prefix phone (all existing
-- numbers predate the 2023 change); this is a forward-looking correctness fix.
-- Sibling of 00461 (+535/535 tolerance).

CREATE OR REPLACE FUNCTION public._normalize_cuban_phone(p_phone text)
  RETURNS text
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO 'pg_catalog'
AS $$
DECLARE
  v_digits text;
BEGIN
  IF p_phone IS NULL THEN
    RETURN NULL;
  END IF;
  v_digits := regexp_replace(p_phone, '\D', '', 'g');
  -- Bare local mobile: 8 digits starting with 5 (legacy) or 6 (new 63/64)
  IF v_digits ~ '^[56]\d{7}$' THEN
    RETURN '+53' || v_digits;
  -- With country code, no +: 53 followed by the 8-digit subscriber number
  ELSIF v_digits ~ '^53\d{8}$' THEN
    RETURN '+' || v_digits;
  END IF;
  RETURN p_phone;
END;
$$;

-- Verification (read-only smoke, run after apply):
--   SELECT public._normalize_cuban_phone('63234567')    AS a,  -- +5363234567
--          public._normalize_cuban_phone('64123456')    AS b,  -- +5364123456
--          public._normalize_cuban_phone('51234567')    AS c,  -- +5351234567 (no regression)
--          public._normalize_cuban_phone('+5363234567') AS d,  -- +5363234567
--          public._normalize_cuban_phone('73234567')    AS e;  -- 73234567 (landline, left raw)
