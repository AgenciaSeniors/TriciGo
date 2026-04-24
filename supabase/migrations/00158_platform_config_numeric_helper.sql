-- ============================================================
-- BUG-095: `platform_config` stores values as JSONB so callers must
-- extract scalars via `(value #>> '{}')::NUMERIC` to avoid the
-- "cannot cast jsonb to numeric" class of errors we hit repeatedly
-- (migrations 00100, 00148-00150 were all flavors of that bug).
--
-- A typed helper removes the footgun: callers say
--   get_platform_config_numeric('commission_rate', 0.15)
-- instead of hand-crafting the JSONB cast. Also provides a text
-- variant for string keys.
--
-- Impact scope: purely additive. Existing RPCs keep working with
-- their inline casts; new call sites should use these helpers.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_platform_config_numeric(
  p_key TEXT,
  p_fallback NUMERIC DEFAULT NULL
) RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_raw JSONB;
  v_out NUMERIC;
BEGIN
  SELECT value INTO v_raw FROM platform_config WHERE key = p_key;
  IF v_raw IS NULL THEN
    RETURN p_fallback;
  END IF;

  -- `#>> '{}'` unwraps the JSONB scalar safely whether it was written
  -- as a string ('"0.15"') or as a JSON number (0.15). Cast to NUMERIC
  -- after.
  BEGIN
    v_out := (v_raw #>> '{}')::NUMERIC;
  EXCEPTION WHEN OTHERS THEN
    v_out := p_fallback;
  END;

  RETURN COALESCE(v_out, p_fallback);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_platform_config_text(
  p_key TEXT,
  p_fallback TEXT DEFAULT NULL
) RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_raw JSONB;
BEGIN
  SELECT value INTO v_raw FROM platform_config WHERE key = p_key;
  IF v_raw IS NULL THEN
    RETURN p_fallback;
  END IF;
  RETURN COALESCE(v_raw #>> '{}', p_fallback);
END;
$$;

COMMENT ON FUNCTION public.get_platform_config_numeric(TEXT, NUMERIC) IS
  'BUG-095: safe numeric extractor for platform_config JSONB values.';

COMMENT ON FUNCTION public.get_platform_config_text(TEXT, TEXT) IS
  'BUG-095: safe text extractor for platform_config JSONB scalars.';
