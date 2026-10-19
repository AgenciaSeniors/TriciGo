-- LIVE function bodies read from prod on 2026-10-19 (pg_get_functiondef), for the 00666 rehearsal.
-- md5(prosrc) and the EXECUTE grants as read; run.sh S0 checks the md5s after loading.

-- _claim_reward(uuid,text,uuid,uuid) md5=d9a8726c2f105908c0df7fe8c59b2982 acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public._claim_reward(p_user_id uuid, p_claim text, p_ride_id uuid DEFAULT NULL::uuid, p_referral_id uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_hash text := public._reward_identity_hash(p_user_id);
  v_ok boolean;
BEGIN
  IF v_hash IS NULL THEN
    RETURN 'no_phone';
  END IF;

  INSERT INTO public.reward_claims (identity_hash, claim, user_id, ride_id, referral_id)
  VALUES (v_hash, p_claim, p_user_id, p_ride_id, p_referral_id)
  ON CONFLICT (identity_hash, claim) DO UPDATE
     SET user_id = EXCLUDED.user_id,
         ride_id = EXCLUDED.ride_id,
         referral_id = EXCLUDED.referral_id,
         claimed_at = now(),
         released_at = NULL
   WHERE public.reward_claims.released_at IS NOT NULL
  RETURNING true INTO v_ok;

  RETURN CASE WHEN v_ok THEN 'claimed' ELSE 'taken' END;
END;
$function$;

-- _gift_wallet_type(uuid) md5=fc1d4ab1b1ad238af448e32c4064c22d acl={=X/postgres,postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public._gift_wallet_type(p_user_id uuid)
 RETURNS wallet_account_type
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE WHEN u.role = 'driver' THEN 'tricicoin'::wallet_account_type
              ELSE 'customer_cash'::wallet_account_type END
  FROM users u WHERE u.id = p_user_id;
$function$;

-- _platform_config_audit_value(jsonb,boolean) md5=e221259c6ce8fa9322380013075413dd acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public._platform_config_audit_value(p_value jsonb, p_is_secret boolean)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN p_value IS NULL THEN NULL
    WHEN p_is_secret THEN jsonb_build_object(
      'redacted', true,
      'sha256_12', left(encode(sha256(convert_to(p_value::text, 'UTF8')), 'hex'), 12))
    ELSE jsonb_build_object('value', p_value)
  END;
$function$;

-- _platform_config_is_telemetry(text) md5=f9a571619f76ddd653767f4211c19912 acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public._platform_config_is_telemetry(p_key text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT p_key ~ '_(at|detail)$' OR p_key = 'weather_last_check';
$function$;

-- _reward_claim_status(uuid,text) md5=73d57eecb3631f0db8d1bc9d7a71fb30 acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public._reward_claim_status(p_user_id uuid, p_claim text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_hash text := public._reward_identity_hash(p_user_id);
BEGIN
  IF v_hash IS NULL THEN
    RETURN 'no_phone';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reward_claims c
              WHERE c.identity_hash = v_hash AND c.claim = p_claim AND c.released_at IS NULL) THEN
    RETURN 'taken';
  END IF;
  RETURN 'free';
END;
$function$;

-- _reward_identity_hash(uuid) md5=4f1942d94b70a77d6b5007d776f5b425 acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public._reward_identity_hash(p_user_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_digits text;
  v_salt text;
BEGIN
  SELECT regexp_replace(u.phone, '\D', '', 'g') INTO v_digits
    FROM auth.users u
   WHERE u.id = p_user_id
     AND u.phone_confirmed_at IS NOT NULL;
  IF v_digits IS NULL OR v_digits = '' THEN
    RETURN NULL;
  END IF;

  SELECT s.salt INTO v_salt FROM public.reward_identity_salt s WHERE s.id = 1;
  IF v_salt IS NULL OR v_salt = '' THEN
    RETURN NULL;
  END IF;

  RETURN encode(sha256(convert_to(v_salt || ':' || v_digits, 'UTF8')), 'hex');
END;
$function$;

-- admin_signup_code_stats() md5=22b65e286149e554225824d766ba81f5 acl={postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.admin_signup_code_stats()
 RETURNS TABLE(code text, label text, channel text, audience text, is_active boolean, created_at timestamp with time zone, signups bigint, rider_signups bigint, driver_signups bigint, drivers_approved bigint, riders_with_ride bigint, drivers_with_ride bigint, promotion_id uuid, promotion_code text, promo_rides bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing()) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH u AS (
    SELECT u.id, u.signup_code, dp.id AS dp_id, dp.status AS dp_status
    FROM public.users u
    LEFT JOIN public.driver_profiles dp ON dp.user_id = u.id
    WHERE u.signup_code IS NOT NULL
  )
  SELECT
    ac.code, ac.label, ac.channel, ac.audience, ac.is_active, ac.created_at,
    count(u.id),
    count(u.id) FILTER (WHERE u.dp_id IS NULL),
    count(u.id) FILTER (WHERE u.dp_id IS NOT NULL),
    count(u.id) FILTER (WHERE u.dp_status = 'approved'),
    count(u.id) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.rides r WHERE r.customer_id = u.id AND r.status = 'completed')),
    count(u.id) FILTER (WHERE u.dp_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.rides r WHERE r.driver_id = u.dp_id AND r.status = 'completed')),
    ac.promotion_id,
    p.code::text,
    (SELECT count(*) FROM public.rides r
       JOIN public.users ru ON ru.id = r.customer_id
      WHERE ac.promotion_id IS NOT NULL
        AND ru.signup_code = ac.code
        AND r.promo_code_id = ac.promotion_id
        AND r.status = 'completed')
  FROM public.acquisition_codes ac
  LEFT JOIN public.promotions p ON p.id = ac.promotion_id
  LEFT JOIN u ON u.signup_code = ac.code
  GROUP BY ac.code, ac.label, ac.channel, ac.audience, ac.is_active, ac.created_at, ac.promotion_id, p.code
  ORDER BY count(u.id) DESC, ac.created_at DESC;
END;
$function$;

-- apply_signup_code(text) md5=940d7a1bec4ce8530de97de271541ae5 acl={postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.apply_signup_code(p_code text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_found text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT code INTO v_found FROM public.acquisition_codes
  WHERE code = v_code AND is_active;
  IF v_found IS NULL THEN
    RETURN 'not_found';
  END IF;

  UPDATE public.users
     SET signup_code = v_found, signup_code_at = now()
   WHERE id = v_uid AND signup_code IS NULL;
  IF FOUND THEN
    RETURN 'applied';
  END IF;
  RETURN 'already_set';
END;
$function$;

-- auth.uid() md5=cdef18c69c4f4cbbced2eaf81e628b49 acl={=X/supabase_auth_admin,supabase_auth_admin=X/supabase_auth_admin,dashboard_user=X/supabase_auth_admin}
CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;

-- cron_http_post(text,text,jsonb,jsonb,integer) md5=15d9ded451c60f92a0fd0a3c4e1ee0ab acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 30000)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net', 'pg_catalog'
AS $function$
DECLARE
  v_url     text := url;
  v_headers jsonb := headers;
  v_body    jsonb := body;
  v_timeout integer := timeout_milliseconds;
  v_id      bigint;
BEGIN
  v_id := net.http_post(url := v_url, headers := v_headers, body := v_body,
                        timeout_milliseconds := v_timeout);
  BEGIN
    INSERT INTO public.cron_http_calls (request_id, jobname, url)
    VALUES (v_id, p_jobname, v_url)
    ON CONFLICT (request_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'cron_http_post: bookkeeping failed for % (request %): % %',
      p_jobname, v_id, SQLSTATE, SQLERRM;
  END;
  RETURN v_id;
END;
$function$;

-- cup_to_trc_centavos(numeric,numeric) md5=f8db4dfddddeef620b300997f7b69c57 acl={=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.cup_to_trc_centavos(p_cup_pesos numeric, p_exchange_rate numeric)
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  -- Rebase 00094: 1 TRC = 1 CUP (sin centavos). Devolver el CUP tal cual.
  -- p_exchange_rate se ignora (se conserva por compatibilidad de firma).
  RETURN ROUND(p_cup_pesos);
END;
$function$;

-- current_user_role() md5=cb4a7c12d4e21fe2997135833f141e25 acl={postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS user_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$function$;

-- ensure_wallet_account(uuid,wallet_account_type) md5=6f01c44a2ecd5afe0b625347b43c203f acl={postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.ensure_wallet_account(p_user_id uuid, p_type wallet_account_type DEFAULT 'customer_cash'::wallet_account_type)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_id  UUID;
  v_uid UUID;
  v_ctx TEXT;
BEGIN
  -- 00591: a DIRECT call (PostgREST RPC from a signed-in, non-admin user)
  -- may only create the caller's own spendable accounts. Internal callers
  -- (send_gift, complete_ride_and_pay, admin_send_gift, the referral and
  -- corporate triggers, ...) are PL/pgSQL functions, so for them PG_CONTEXT
  -- carries at least one more frame below this one; a direct call has
  -- exactly one frame and therefore no newline. Service-role/cron callers
  -- have auth.uid() IS NULL and admins are exempt.
  v_uid := auth.uid();
  IF v_uid IS NOT NULL THEN
    GET DIAGNOSTICS v_ctx = PG_CONTEXT;
    IF position(E'\n' IN v_ctx) = 0 AND NOT is_admin() THEN
      IF p_user_id IS DISTINCT FROM v_uid
         OR p_type NOT IN ('customer_cash', 'tricicoin', 'corporate_cash') THEN
        RAISE EXCEPTION 'forbidden: ensure_wallet_account may only create your own customer_cash, tricicoin or corporate_cash account'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  SELECT id INTO v_id FROM wallet_accounts WHERE user_id = p_user_id AND account_type = p_type;
  IF v_id IS NULL THEN
    INSERT INTO wallet_accounts (id, user_id, account_type, balance, held_balance, currency, anchor_usd_cents)
    VALUES (gen_random_uuid(), p_user_id, p_type, 0, 0, 'TRC',
            CASE WHEN p_type IN ('customer_cash', 'corporate_cash', 'tricicoin') THEN 0 ELSE NULL END)
    ON CONFLICT (user_id, account_type) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM wallet_accounts WHERE user_id = p_user_id AND account_type = p_type;
    END IF;
  END IF;
  RETURN v_id;
END;
$function$;

-- get_current_exchange_rate() md5=7377e83a3477419ad6c3897dca8a2835 acl={=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.get_current_exchange_rate()
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE v_rate NUMERIC;
BEGIN
  SELECT usd_cup_rate INTO v_rate FROM exchange_rates WHERE is_current = true LIMIT 1;
  IF v_rate IS NULL THEN
    SELECT usd_cup_rate INTO v_rate FROM exchange_rates ORDER BY fetched_at DESC LIMIT 1;
  END IF;
  IF v_rate IS NULL THEN
    SELECT (value #>> '{}')::NUMERIC INTO v_rate FROM platform_config WHERE key = 'exchange_rate_fallback_cup';
    v_rate := COALESCE(v_rate, 640.0);
  END IF;
  RETURN v_rate;
END;
$function$;

-- get_platform_config_numeric(text,numeric) md5=13d2587037eca74854cf2394ba42a90c acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.get_platform_config_numeric(p_key text, p_fallback numeric DEFAULT NULL::numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
$function$;

-- get_service_role_key() md5=a0b1b63fcf1499ffb407a5718826b02c acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.get_service_role_key()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_key text;
BEGIN
  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;
  RETURN v_key;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$function$;

-- is_admin() md5=22cb75e91980d512498034cd33e1eda2 acl={=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron, triggers without a user. None of
  -- them is an admin, and anon may not even call current_user_role().
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin');
END;
$function$;

-- is_marketing() md5=1903156b6a1218a543888ae2ebfb3656 acl={postgres=X/postgres,service_role=X/postgres,anon=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.is_marketing()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron. None of them is marketing, and anon may not
  -- call current_user_role() (00517). Same early return as is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() = 'marketing';
END;
$function$;

-- is_super_admin() md5=5655a4615e92e8b1e323d06c7566b058 acl={postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE id = auth.uid()
      AND role = 'super_admin'
  );
$function$;

-- platform_config_can_read_secrets() md5=c38ca8f2ee39238d8c37a3f0b47ac879 acl={=X/postgres,postgres=X/postgres,service_role=X/postgres,anon=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.platform_config_can_read_secrets()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN COALESCE(is_admin(), false);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$function$;

-- platform_config_is_secret(text) md5=7302ae9b8e160f90a253d5f5ace0f0b5 acl={=X/postgres,postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.platform_config_is_secret(p_key text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT p_key NOT ILIKE '%publishable%'
     AND (
       p_key ~ '(_token|_secret|_signature|_hash|_api_key|_password)$'
       OR p_key IN (
         'eltoque_api_token',
         'infobip_api_key',
         'openweather_api_key',
         'smspm_token',
         'smspm_hash',
         'netopia_live_signature',
         'netopia_sandbox_signature'
       )
     );
$function$;

-- promotion_is_referenced(uuid) md5=d02d1233dcb808f809ff0dcf29818a02 acl={postgres=X/postgres,authenticated=X/postgres}
CREATE OR REPLACE FUNCTION public.promotion_is_referenced(p_promotion_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN NOT (public.is_marketing() OR public.is_admin()) THEN false
    ELSE EXISTS (SELECT 1 FROM public.rides WHERE promo_code_id = p_promotion_id)
      OR EXISTS (SELECT 1 FROM public.promotion_uses WHERE promotion_id = p_promotion_id)
      OR EXISTS (SELECT 1 FROM public.campaigns WHERE promo_code_id = p_promotion_id)
  END;
$function$;

-- tg_acquisition_codes_guard() md5=383b43d28d0e0598a9233fafd1eba296 acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.tg_acquisition_codes_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  NEW.code := upper(btrim(NEW.code));
  IF EXISTS (SELECT 1 FROM public.referral_codes WHERE code = NEW.code) THEN
    RAISE EXCEPTION 'El código % ya es un código de referido de un usuario', NEW.code
      USING ERRCODE = '23505';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.created_by IS NULL THEN
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$function$;

-- tg_platform_config_audit() md5=23121ec16ff092678dae2aca522220ff acl={postgres=X/postgres,service_role=X/postgres}
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

-- tg_promotions_marketing_guard() md5=2b4dd44a23aaf0c01a47b28d6b09cae4 acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.tg_promotions_marketing_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  -- What the approval and the use counter write. Every other column is content: changing it
  -- makes a new revision, one no admin has seen yet.
  c_bookkeeping constant text[] := ARRAY['is_active', 'notified_at', 'pending_approval',
    'approved_by', 'approved_at', 'current_uses', 'revision', 'created_at'];
  v_marketing boolean;
BEGIN
  -- Marketing's rules bind marketing's own writes through the API, nothing else. A ride claims
  -- a promotion use (tg_rides_validate_promo_discount) and gives it back on cancel
  -- (tg_rides_rollback_promo_on_cancel) inside SECURITY DEFINER triggers, with the passenger's
  -- JWT still set. There current_user is their owner, so a marketing account rides with a
  -- promo code like anyone else.
  v_marketing := current_user IN ('anon', 'authenticated') AND public.is_marketing();

  IF TG_OP = 'DELETE' THEN
    -- Only a paused promotion that nothing points at. Deleting one that a ride, a use or a
    -- campaign still names would rewrite their history (the foreign keys set it to NULL).
    IF v_marketing AND (OLD.is_active OR OLD.current_uses > 0
                        OR public.promotion_is_referenced(OLD.id)) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Solo se puede borrar una promoción pausada que nadie usó.',
        DETAIL = 'promo_delete_blocked';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.revision := 0;
    IF v_marketing THEN
      -- A draft, whatever the request says. Only an admin turns it on.
      NEW.is_active := false;
      NEW.pending_approval := true;
      NEW.created_by := auth.uid();
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
      NEW.current_uses := 0;
      NEW.notified_at := NULL;
    END IF;
  ELSE
    -- Nobody writes the revision. It only counts content changes (below).
    NEW.revision := OLD.revision;
    IF v_marketing AND OLD.is_active THEN
      -- A live promotion: marketing may pause it, or stamp the push "Notificar ahora" just sent.
      IF (to_jsonb(NEW) - 'is_active' - 'notified_at') IS DISTINCT FROM (to_jsonb(OLD) - 'is_active' - 'notified_at') THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'Pausa la promoción para editarla.',
          DETAIL = 'promo_active_locked';
      END IF;
    ELSIF v_marketing THEN
      IF NEW.is_active THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'Solo un administrador puede activar una promoción.',
          DETAIL = 'promo_activation_requires_admin';
      END IF;
      -- Marketing never writes the approval or the counters. Nor the push stamp of a promotion
      -- that is off: "Notificar ahora" is for live ones, and a stamp on a draft would decide
      -- whether its approval sends the publish push.
      NEW.pending_approval := OLD.pending_approval;
      NEW.approved_by := OLD.approved_by;
      NEW.approved_at := OLD.approved_at;
      NEW.created_by := OLD.created_by;
      NEW.current_uses := OLD.current_uses;
      NEW.notified_at := OLD.notified_at;
    END IF;
    IF (to_jsonb(NEW) - c_bookkeeping) IS DISTINCT FROM (to_jsonb(OLD) - c_bookkeeping) THEN
      NEW.revision := OLD.revision + 1;
      -- A draft marketing edited goes back to the admins. A marketing write that changes nothing
      -- it offers (a second pause, a stale save) leaves the wait as it was.
      IF v_marketing THEN
        NEW.pending_approval := true;
      END IF;
    END IF;
  END IF;

  -- Turning a promotion on, by anyone, ends its wait for approval. Only an admin's or
  -- super_admin's activation is an approval and gets the stamp; the service role, cron and SQL
  -- without a JWT turn it on unstamped.
  IF NEW.is_active AND (TG_OP = 'INSERT' OR NOT OLD.is_active) THEN
    NEW.pending_approval := false;
    IF public.is_admin() THEN
      NEW.approved_by := auth.uid();
      NEW.approved_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- log_rpc_attempt(text,uuid,uuid,text,jsonb) md5=0a902c34a1148dac5686403a7c941bc0 acl={postgres=X/postgres,service_role=X/postgres}
-- (read from prod on 2026-10-19 after the first rehearsal; table: rpc_attempt_log(id bigserial PK, rpc_name text NOT NULL, caller_uid uuid, target_id uuid, outcome text NOT NULL, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now()))
CREATE OR REPLACE FUNCTION public.log_rpc_attempt(p_rpc_name text, p_caller_uid uuid, p_target_id uuid, p_outcome text, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO rpc_attempt_log (rpc_name, caller_uid, target_id, outcome, metadata)
  VALUES (p_rpc_name, p_caller_uid, p_target_id, p_outcome, p_metadata);
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$function$;
