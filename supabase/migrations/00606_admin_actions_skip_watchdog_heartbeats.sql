-- ============================================================
-- 00606 — Stop auditing watchdog heartbeats into admin_actions,
--         drop the ones already stored, and make the admin reads cheap
--
-- WHY
--
-- tg_platform_config_audit (00603) writes one admin_actions row for every
-- platform_config UPDATE that changes the value. The watchdogs (NETOPIA
-- proxy, SMS, FX, cron, database health, POI sync, weather) keep their
-- "last checked" timestamp and detail line in platform_config, so every run
-- of every watchdog lands in admin_actions. Measured on 2026-10-06:
--
--   * 168,881 rows, 75 MB, and no index besides the primary key;
--   * 167,549 of them (99.2 %) attributed to the platform account
--     00000000-0000-0000-0000-000000000001, the fallback when no JWT is set;
--   * ~2,000 new ones a day, almost all on keys ending in _at or _detail
--     (netopia_proxy_health_at/_detail alone: 54,449 each);
--   * the admin home's "recent automated actions" query
--       admin_actions?admin_id=eq.<platform>&order=created_at.desc&limit=6
--     took 3.3 s warm (seq scan of every row, is_admin() evaluated per row:
--     508k buffer hits) and hit the 8 s statement_timeout three times on
--     2026-10-05 (HTTP 500, PostgREST error 57014). The page swallows the
--     error and shows an empty list; when it does answer, the six rows are
--     heartbeats, not automated actions.
--
-- A heartbeat is not an administrative action: nobody decided anything. The
-- value is already in platform_config and each watchdog keeps its own state
-- and alert history (00503, 00507, 00577, 00596).
--
-- WHAT
--
--   A. _platform_config_is_telemetry(key): true for keys ending in _at or
--      _detail, plus weather_last_check. On 2026-10-06 that matches 20 keys
--      in prod and every one of them is a watchdog timestamp or status line;
--      no tunable setting has either suffix.
--   B. tg_platform_config_audit skips an UPDATE only when BOTH hold: the key
--      is telemetry (A) and there is no JWT subject (cron, Edge Functions,
--      the VPS watchdog through its Edge Function). INSERT and DELETE are
--      always audited, and so is any change made by a signed-in person,
--      telemetry key or not. Everything else is the 00603 body unchanged
--      (same redaction, same platform-account fallback, same "value
--      unchanged -> no row"). The step refuses to run over a body it does
--      not recognise.
--   C. Delete the stored heartbeats: platform-account UPDATE rows on
--      telemetry keys. Rows written by people are never touched. Measured
--      on 2026-10-06: 166,128 rows go, 2,763 stay (1,332 of them written by
--      people, none on a telemetry key). With only the primary key on a
--      75 MB table this is one pass, not a batched purge (cf. 00576, which
--      had a 1.1 GB table).
--   D. Indexes for the two admin reads: (admin_id, created_at DESC) for the
--      home widget, (created_at DESC) for the audit page.
--   E. aa_select evaluates is_admin() once per statement instead of once per
--      row: USING ((SELECT is_admin())). Same rows visible, same roles.
--
-- Not reclaimed: DELETE leaves the 75 MB file at its size, as reusable space.
-- Autovacuum makes it reusable; VACUUM FULL would give it back but takes an
-- ACCESS EXCLUSIVE lock, so it is left out on purpose.
--
-- Idempotent: A/B are CREATE OR REPLACE (B also accepts its own body), C
-- deletes what still matches, D uses IF NOT EXISTS, E is an ALTER. The
-- closing block asserts the end state and probes the trigger inside a
-- subtransaction that is always rolled back.
-- ============================================================

SET lock_timeout = '5s';

-- A. What counts as a watchdog heartbeat ----------------------------------
CREATE OR REPLACE FUNCTION public._platform_config_is_telemetry(p_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT p_key ~ '_(at|detail)$' OR p_key = 'weather_last_check';
$$;

COMMENT ON FUNCTION public._platform_config_is_telemetry(text) IS
  '00606: platform_config keys that watchdogs rewrite on every run (timestamps, status lines). Their automated updates are not audited into admin_actions.';

REVOKE ALL ON FUNCTION public._platform_config_is_telemetry(text) FROM PUBLIC, anon, authenticated;

-- B. The audit trigger skips automated heartbeat updates ------------------
DO $guard$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5
  FROM pg_proc WHERE oid = 'public.tg_platform_config_audit()'::regprocedure;

  -- 4428771395a0087328397de94dab15e8: the 00603 body (prod on 2026-10-06).
  -- A body this migration wrote carries the 00606 marker.
  IF v_md5 IS DISTINCT FROM '4428771395a0087328397de94dab15e8'
     AND NOT EXISTS (SELECT 1 FROM pg_proc
                     WHERE oid = 'public.tg_platform_config_audit()'::regprocedure
                       AND prosrc LIKE '%00606: watchdog heartbeat%') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = format('00606: tg_platform_config_audit has an unknown body (md5 %s); rebase this migration on it', v_md5);
  END IF;
END
$guard$;

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
      -- 00606: watchdog heartbeat. An automated write (no JWT subject) to a
      -- telemetry key is not an administrative action; a person's write is
      -- always audited.
      IF auth.uid() IS NULL AND public._platform_config_is_telemetry(NEW.key) THEN
        RETURN NEW;
      END IF;
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

-- C. Delete the heartbeats already stored ---------------------------------
DELETE FROM public.admin_actions
WHERE admin_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND action = 'update_platform_config'
  AND target_type = 'platform_config'
  AND public._platform_config_is_telemetry(target_id);

-- D. Indexes for the admin reads -------------------------------------------
CREATE INDEX IF NOT EXISTS admin_actions_admin_id_created_at_idx
  ON public.admin_actions (admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_actions_created_at_idx
  ON public.admin_actions (created_at DESC);

-- E. is_admin() once per statement, not once per row -----------------------
ALTER POLICY aa_select ON public.admin_actions USING ((SELECT public.is_admin()));

-- Assert the end state ----------------------------------------------------
DO $check$
DECLARE
  v_left int;
  v_qual text;
  v_rows int;
BEGIN
  SELECT count(*) INTO v_left
  FROM public.admin_actions
  WHERE admin_id = '00000000-0000-0000-0000-000000000001'::uuid
    AND action = 'update_platform_config'
    AND target_type = 'platform_config'
    AND public._platform_config_is_telemetry(target_id);
  IF v_left <> 0 THEN
    RAISE EXCEPTION '00606: % heartbeat rows still in admin_actions', v_left;
  END IF;

  IF to_regclass('public.admin_actions_admin_id_created_at_idx') IS NULL
     OR to_regclass('public.admin_actions_created_at_idx') IS NULL THEN
    RAISE EXCEPTION '00606: admin_actions indexes missing';
  END IF;

  SELECT qual INTO v_qual FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'admin_actions' AND policyname = 'aa_select';
  IF v_qual IS NULL OR v_qual !~* '^\(\s*SELECT\s+(public\.)?is_admin\(\)' THEN
    RAISE EXCEPTION '00606: aa_select is not (SELECT is_admin()) but %', coalesce(v_qual, 'missing');
  END IF;

  -- Probe the trigger with throwaway keys. The inner block always raises, so
  -- the rows it writes, the audit rows and the JWT settings are rolled back.
  BEGIN
    -- automated: a heartbeat key is audited on INSERT only, a normal key on both
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO public.platform_config (key, value) VALUES
      ('zz_00606_probe_at', to_jsonb('a'::text)),
      ('zz_00606_probe_setting', to_jsonb(1));
    UPDATE public.platform_config SET value = to_jsonb('b'::text) WHERE key = 'zz_00606_probe_at';
    UPDATE public.platform_config SET value = to_jsonb(2) WHERE key = 'zz_00606_probe_setting';

    -- a signed-in person: a heartbeat key is audited too
    PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
    UPDATE public.platform_config SET value = to_jsonb('c'::text) WHERE key = 'zz_00606_probe_at';

    SELECT count(*) INTO v_rows FROM public.admin_actions
    WHERE target_type = 'platform_config' AND target_id IN ('zz_00606_probe_at', 'zz_00606_probe_setting');

    -- expected: 2 inserts + 1 automated setting update + 1 signed-in heartbeat update
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = CASE WHEN v_rows = 4 THEN '00606_probe_ok' ELSE '00606_probe_bad: ' || v_rows || ' audit rows, expected 4' END;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> '00606_probe_ok' THEN
      RAISE EXCEPTION '00606: audit trigger probe failed (%)', SQLERRM;
    END IF;
  END;
END
$check$;

RESET lock_timeout;
