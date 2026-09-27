-- ============================================================
-- 00603 — Stop copying platform_config secrets into admin_actions,
--         and drop the dead Infobip / SMSPM rows
--
-- WHY
--
-- tg_platform_config_audit (AFTER INSERT/UPDATE/DELETE on platform_config)
-- writes the full `value` of the row into admin_actions.old_values /
-- new_values. For the keys that platform_config_is_secret() protects (00517:
-- provider API tokens, NETOPIA signatures) that means:
--
--   * rotating a token from the admin panel stores BOTH the old and the new
--     token in admin_actions, where every admin can read them (aa_select =
--     is_admin()) and nothing ever expires them;
--   * deleting a secret row stores its value there too.
--
-- The provider tokens in platform_config (eltoque_api_token,
-- openweather_api_key, …) have to be rotated after the database password
-- leak (the postgres role reads every row) and after 00517 (until
-- 2026-07-27 any holder of the publishable key could read them). Rotating
-- them through the panel before this fix would just move the new tokens into
-- a second table. So this runs first.
--
-- WHAT
--
--   A. _platform_config_audit_value(value, is_secret): the plain value for
--      normal keys; for secret keys only {"redacted": true, "sha256_12": …},
--      the first 12 hex characters of SHA-256 over the value's JSON text. A
--      reviewer can still tell that the value changed, and whether two
--      entries hold the same value, without being able to recover it.
--   B. tg_platform_config_audit keeps its behaviour (same actions, same
--      admin fallback, no row when an UPDATE leaves the value alone) and
--      routes every value through (A). An UPDATE is treated as secret when
--      either the old or the new key is.
--   C. Redact the copies already stored: admin_actions rows of secret keys
--      that still carry a "value".
--   D. Delete the Infobip and SMSPM rows. Neither provider is used: no Edge
--      Function, database function or cron job reads them (00063 already
--      noted "Infobip config removed"; SMS goes through D7). Deleting the
--      rows does NOT revoke the credentials; that is done in each provider's
--      dashboard. D runs after B, so the audit rows it produces are
--      redacted. The step refuses to run if anything in the database starts
--      referencing either provider.
--
-- Idempotent: A/B are CREATE OR REPLACE, C only touches rows that still hold
-- a value, D deletes by key. The closing block asserts the end state and
-- probes the trigger inside a subtransaction that is always rolled back.
-- ============================================================

-- A. Value shaping for the audit trail -----------------------------------
CREATE OR REPLACE FUNCTION public._platform_config_audit_value(p_value jsonb, p_is_secret boolean)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT CASE
    WHEN p_value IS NULL THEN NULL
    WHEN p_is_secret THEN jsonb_build_object(
      'redacted', true,
      'sha256_12', left(encode(sha256(convert_to(p_value::text, 'UTF8')), 'hex'), 12))
    ELSE jsonb_build_object('value', p_value)
  END;
$$;

COMMENT ON FUNCTION public._platform_config_audit_value(jsonb, boolean) IS
  '00603: audit payload for platform_config. Secret keys (platform_config_is_secret) are stored as a 12-hex SHA-256 fingerprint, never the value.';

REVOKE ALL ON FUNCTION public._platform_config_audit_value(jsonb, boolean) FROM PUBLIC, anon, authenticated;

-- B. The audit trigger, same behaviour, redacted payloads -----------------
CREATE OR REPLACE FUNCTION public.tg_platform_config_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_admin UUID := COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000001'::uuid);
  v_secret boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_secret := public.platform_config_is_secret(NEW.key);
    INSERT INTO admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
    VALUES (v_admin, 'insert_platform_config', 'platform_config', NEW.key, NULL,
            public._platform_config_audit_value(NEW.value, v_secret));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Skip if nothing meaningful changed.
    IF OLD.value IS DISTINCT FROM NEW.value THEN
      v_secret := public.platform_config_is_secret(OLD.key) OR public.platform_config_is_secret(NEW.key);
      INSERT INTO admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
      VALUES (v_admin, 'update_platform_config', 'platform_config', NEW.key,
              public._platform_config_audit_value(OLD.value, v_secret),
              public._platform_config_audit_value(NEW.value, v_secret));
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    v_secret := public.platform_config_is_secret(OLD.key);
    INSERT INTO admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
    VALUES (v_admin, 'delete_platform_config', 'platform_config', OLD.key,
            public._platform_config_audit_value(OLD.value, v_secret), NULL);
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$function$;

-- C. Redact the secret values already copied into admin_actions ----------
UPDATE public.admin_actions
SET old_values = CASE WHEN old_values ? 'value'
                      THEN public._platform_config_audit_value(old_values -> 'value', true)
                      ELSE old_values END,
    new_values = CASE WHEN new_values ? 'value'
                      THEN public._platform_config_audit_value(new_values -> 'value', true)
                      ELSE new_values END
WHERE target_type = 'platform_config'
  AND public.platform_config_is_secret(target_id)
  AND (old_values ? 'value' OR new_values ? 'value');

-- D. Drop the dead Infobip / SMSPM configuration --------------------------
DO $dead$
DECLARE
  v_users text;
BEGIN
  SELECT string_agg(n.nspname || '.' || p.proname, ', ')
    INTO v_users
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND p.proname <> 'platform_config_is_secret'
    AND (p.prosrc ILIKE '%infobip%' OR p.prosrc ILIKE '%smspm%');

  IF v_users IS NULL AND to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $q$SELECT string_agg('cron:' || jobname, ', ') FROM cron.job
               WHERE command ILIKE '%infobip%' OR command ILIKE '%smspm%'$q$
      INTO v_users;
  END IF;

  IF v_users IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = format('00603: refusing to delete Infobip/SMSPM config, still referenced by %s', v_users);
  END IF;

  DELETE FROM public.platform_config
  WHERE key IN ('infobip_api_key', 'infobip_base_url', 'infobip_whatsapp_sender',
                'smspm_token', 'smspm_hash', 'smspm_sender');
END
$dead$;

-- Assert the end state ----------------------------------------------------
DO $check$
DECLARE
  v_left int;
  v_probe jsonb;
BEGIN
  SELECT count(*) INTO v_left
  FROM public.platform_config
  WHERE key IN ('infobip_api_key', 'infobip_base_url', 'infobip_whatsapp_sender',
                'smspm_token', 'smspm_hash', 'smspm_sender');
  IF v_left <> 0 THEN
    RAISE EXCEPTION '00603: % Infobip/SMSPM rows still present', v_left;
  END IF;

  SELECT count(*) INTO v_left
  FROM public.admin_actions
  WHERE target_type = 'platform_config'
    AND public.platform_config_is_secret(target_id)
    AND (old_values ? 'value' OR new_values ? 'value');
  IF v_left <> 0 THEN
    RAISE EXCEPTION '00603: % admin_actions rows still hold a secret value', v_left;
  END IF;

  -- Probe the trigger with a throwaway secret key. The inner block always
  -- raises, so the insert and its audit row are rolled back.
  BEGIN
    INSERT INTO public.platform_config (key, value)
    VALUES ('zz_00603_probe_api_key', to_jsonb('probe-value'::text));

    SELECT new_values INTO v_probe
    FROM public.admin_actions
    WHERE target_type = 'platform_config' AND target_id = 'zz_00603_probe_api_key';

    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = CASE
        WHEN v_probe IS NOT NULL AND NOT (v_probe ? 'value') AND (v_probe ->> 'redacted') = 'true'
          THEN '00603_probe_ok'
        ELSE '00603_probe_bad: ' || coalesce(v_probe::text, 'no audit row')
      END;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> '00603_probe_ok' THEN
      RAISE EXCEPTION '00603: audit trigger did not redact a secret key (%)',
        CASE WHEN SQLERRM LIKE '00603_probe_bad:%' THEN 'value stored' ELSE SQLERRM END;
    END IF;
  END;
END
$check$;
