-- 00684: record every promo-code validation in rpc_attempt_log.
--
-- Why: on 2026-11-16 marketing reported that BIENVENIDA showed up as already
-- used for an account that had never used it. validate_promo_code wrote
-- nothing, and the edge logs keep the request but not the answer, so what the
-- app was told could not be reconstructed. From here on each call leaves one
-- row: rpc_name 'validate_promo_code', caller_uid = auth.uid(), target_id =
-- p_user_id, outcome 'valid' or the error key the app received ('invalid',
-- 'expired', 'max_uses', 'already_used', 'phone_required', 'first_ride_only',
-- 'unauthenticated', 'forbidden'), and metadata {code, promotion_id, discount}.
-- rpc_attempt_log is pruned after 90 days (cron prune-rpc-attempt-log).
--
-- What does not change: the answer. The function body is the live one (00674,
-- md5 0230d4d0...) with each of its 13 RETURN statements wrapped in
-- _log_promo_validation(), which returns its input untouched and never raises
-- (log_rpc_attempt swallows its own errors too). The function becomes VOLATILE
-- because a STABLE function cannot write; the apps call it with POST, so
-- nothing on the client changes.
--
-- A later migration that redefines validate_promo_code must start from the
-- body this one leaves (md5 40087366...), or the log goes silent.

-- 1. The logger. Only the owner calls it, from validate_promo_code.
CREATE OR REPLACE FUNCTION public._log_promo_validation(p_user_id uuid, p_code text, p_result jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
BEGIN
  BEGIN
    PERFORM public.log_rpc_attempt(
      'validate_promo_code',
      auth.uid(),
      p_user_id,
      CASE WHEN p_result->>'valid' = 'true' THEN 'valid'
           ELSE COALESCE(p_result->>'error', 'invalid') END,
      jsonb_strip_nulls(jsonb_build_object(
        'code', left(COALESCE(p_code, ''), 40),
        'promotion_id', p_result->>'promotion_id',
        'discount', p_result->'discount_amount'
      ))
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN p_result;
END
$fn$;

REVOKE ALL ON FUNCTION public._log_promo_validation(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._log_promo_validation(uuid, text, jsonb) TO service_role;

-- 2. Wrap each RETURN of the live validate_promo_code, refusing a body this
--    migration does not know. Re-running it once applied changes nothing.
DO $patch$
DECLARE
  c_fn      constant regprocedure := 'public.validate_promo_code(text, uuid, integer)'::regprocedure;
  c_old_md5 constant text := '0230d4d0e7df6146d5dd72ec7233f916';
  c_new_md5 constant text := '40087366d75f95b020596288dfb75f69';
  c_marker  constant text := 'RETURN jsonb_build_object(';
  c_wrap    constant text := 'RETURN public._log_promo_validation(p_user_id, v_normalized, ';
  v_src  text;
  v_def  text;
  v_out  text := '';
  v_rest text;
  v_stmt text;
  i int;
  j int;
  n int := 0;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = c_fn;

  IF md5(v_src) = c_new_md5 THEN
    RAISE NOTICE '00684: validate_promo_code already logs its answers';
    RETURN;
  END IF;
  IF md5(v_src) <> c_old_md5 THEN
    RAISE EXCEPTION '00684: validate_promo_code is not the body this migration knows (md5 %, length %)',
      md5(v_src), length(v_src);
  END IF;

  -- Each RETURN statement ends at the first semicolon after it: none of the
  -- jsonb_build_object arguments contains one.
  v_rest := v_src;
  LOOP
    i := position(c_marker IN v_rest);
    EXIT WHEN i = 0;
    j := position(';' IN substr(v_rest, i));
    IF j = 0 THEN
      RAISE EXCEPTION '00684: a RETURN of validate_promo_code has no semicolon';
    END IF;
    v_stmt := substr(v_rest, i, j);
    v_out := v_out || substr(v_rest, 1, i - 1) || c_wrap || substr(v_stmt, 8, j - 8) || ');';
    v_rest := substr(v_rest, i + j);
    n := n + 1;
  END LOOP;
  v_out := v_out || v_rest;

  IF n <> 13 THEN
    RAISE EXCEPTION '00684: expected 13 RETURN statements in validate_promo_code, found %', n;
  END IF;
  IF md5(v_out) <> c_new_md5 THEN
    RAISE EXCEPTION '00684: the patched body has md5 %, expected %', md5(v_out), c_new_md5;
  END IF;

  v_def := pg_get_functiondef(c_fn);
  IF position(v_src IN v_def) = 0 THEN
    RAISE EXCEPTION '00684: the body is not inside pg_get_functiondef';
  END IF;
  EXECUTE replace(v_def, v_src, v_out);
END
$patch$;

-- A STABLE function cannot write the log row.
ALTER FUNCTION public.validate_promo_code(text, uuid, integer) VOLATILE;

-- 3. Checks: the body, the attributes and the grants are the expected ones, and
--    a call leaves exactly one row (in a subtransaction that is rolled back).
DO $check$
DECLARE
  c_fn     constant regprocedure := 'public.validate_promo_code(text, uuid, integer)'::regprocedure;
  c_logger constant regprocedure := 'public._log_promo_validation(uuid, text, jsonb)'::regprocedure;
  r       record;
  v_res   jsonb;
  v_rows  int;
  v_outc  text;
BEGIN
  SELECT p.prosrc, p.provolatile, p.prosecdef, p.proconfig INTO r FROM pg_proc p WHERE p.oid = c_fn;
  IF md5(r.prosrc) <> '40087366d75f95b020596288dfb75f69' THEN
    RAISE EXCEPTION '00684 check: validate_promo_code body md5 is %', md5(r.prosrc);
  END IF;
  IF r.provolatile <> 'v' THEN
    RAISE EXCEPTION '00684 check: validate_promo_code is not VOLATILE (%)', r.provolatile;
  END IF;
  IF NOT r.prosecdef OR NOT ('search_path=public, pg_catalog' = ANY (r.proconfig)) THEN
    RAISE EXCEPTION '00684 check: validate_promo_code lost SECURITY DEFINER or its search_path';
  END IF;
  IF NOT has_function_privilege('authenticated', c_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00684 check: authenticated can no longer call validate_promo_code';
  END IF;
  IF has_function_privilege('anon', c_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00684 check: anon can call validate_promo_code';
  END IF;
  IF has_function_privilege('anon', c_logger, 'EXECUTE')
     OR has_function_privilege('authenticated', c_logger, 'EXECUTE') THEN
    RAISE EXCEPTION '00684 check: a client can call _log_promo_validation';
  END IF;
  IF position(chr(13) IN (SELECT prosrc FROM pg_proc WHERE oid = c_logger)) > 0 THEN
    RAISE EXCEPTION '00684 check: _log_promo_validation carries carriage returns';
  END IF;

  BEGIN
    -- Without a JWT the answer is 'unauthenticated' and the row has no caller.
    -- The claims are cleared here, whatever the session had; the rollback of
    -- this subtransaction restores them.
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    v_res := public.validate_promo_code('00684-SELFTEST', NULL, 0);
    SELECT count(*), max(outcome) INTO v_rows, v_outc
      FROM public.rpc_attempt_log
     WHERE rpc_name = 'validate_promo_code'
       AND metadata->>'code' = '00684-SELFTEST'
       AND created_at >= now();
    RAISE EXCEPTION USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    NULL;
  END;
  IF v_res IS DISTINCT FROM '{"valid": false, "error": "unauthenticated"}'::jsonb THEN
    RAISE EXCEPTION '00684 check: the answer changed (%)', v_res;
  END IF;
  IF v_rows <> 1 OR v_outc <> 'unauthenticated' THEN
    RAISE EXCEPTION '00684 check: a call left % rows (outcome %), expected 1 unauthenticated', v_rows, v_outc;
  END IF;
END
$check$;
