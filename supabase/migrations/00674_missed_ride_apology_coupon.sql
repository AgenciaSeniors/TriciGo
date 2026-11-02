-- 00674: an apology coupon for people whose ride found no driver.
--
-- Spec: docs/superpowers/specs/2026-11-02-missed-ride-apology-coupon-design.md
--
-- The panel's /missed-rides page lists passengers whose request was canceled with no driver after
-- waiting support_alert_after_s, with no ride since (completed, or disputed, which only a completed
-- ride can become: 00634). An operator (or an admin) writes to each one by WhatsApp:
--
--   admin_missed_riders(view, days)       the list, for operations staff;
--   admin_missed_ride_coupon()            the coupon in use: the newest active grant-only promotion;
--   ops_contact_missed_rider(user, at)    records the contact and, once per confirmed phone ever,
--                                         gives the person that coupon (promotion_grants).
--
-- The coupon applies on its own on the person's next passenger ride (rides_promo_grant, before
-- rides_signup_promo and the promo validator). Nobody else can use it, even typing its code: the
-- validator and validate_promo_code refuse a grant-only promotion without a grant. The installed
-- apps prefill it through get_my_signup_promotion, which returns it first.
--
-- A grant-only promotion is chosen as such when it is created and never changes
-- (promotions_grant_only_frozen, for everyone: a deliberate change goes through a migration), and
-- it is never first-ride-only: it is meant for people who may have ridden before.
--
-- tg_rides_promo_grant is SECURITY INVOKER on purpose, like tg_rides_signup_promo (00665): it
-- tells a ride a person creates (current_user anon or authenticated) from one a SECURITY DEFINER
-- function, the cron or the service role creates.

SET LOCAL lock_timeout = '5s';

-- Rides before promotions, the order a ride write with a promotion takes (00665). Inside DO so a
-- second run in autocommit still works (a bare LOCK needs a transaction block).
DO $lock$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE public.rides IN SHARE ROW EXCLUSIVE MODE;
END
$lock$;

-- 0. The three bodies it patches are the ones read from prod on 2026-11-02, or already patched.
DO $guard$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    SELECT f.fn, f.want, md5(replace(p.prosrc, chr(13), '')) AS got,
           position(f.marker IN p.prosrc) > 0 AS patched
      FROM (VALUES
        ('public.tg_rides_validate_promo_discount()', 'cad4cf62d95e5055950b67564c6da7f4',
         '00674: a grant-only promotion counts only for the person it was given to.'),
        ('public.validate_promo_code(text,uuid,integer)', '952805817a1ea73ab0fbb93f28884a30',
         '00674: a grant-only promotion is invalid for anyone it was not given to.'),
        ('public.get_my_signup_promotion()', 'b4209984f4bd3e9e822e28e3e28eb3c9',
         '00674: an apology coupon goes first')
      ) AS f(fn, want, marker)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.fn)
  LOOP
    IF v_row.got IS NULL THEN
      RAISE EXCEPTION '00674: % does not exist', v_row.fn;
    END IF;
    IF NOT v_row.patched AND v_row.got <> v_row.want THEN
      RAISE EXCEPTION '00674: % is not the body read from prod (md5 %)', v_row.fn, v_row.got;
    END IF;
  END LOOP;
END
$guard$;

-- 1. Data.
ALTER TABLE public.promotions ADD COLUMN IF NOT EXISTS grant_only boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.promotions.grant_only IS
  '00674: an apology coupon. Only a person with a promotion_grants row can use it, and it is never public.';

DO $constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.promotions'::regclass AND conname = 'promotions_grant_only_private') THEN
    ALTER TABLE public.promotions ADD CONSTRAINT promotions_grant_only_private
      CHECK (NOT (grant_only AND COALESCE(is_public, true)));
  END IF;
  -- An apology coupon has to work for people who rode before: never first-ride-only.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.promotions'::regclass AND conname = 'promotions_grant_only_any_ride') THEN
    ALTER TABLE public.promotions ADD CONSTRAINT promotions_grant_only_any_ride
      CHECK (NOT (grant_only AND COALESCE(first_ride_only, false)));
  END IF;
END
$constraint$;

-- grant_only is chosen once, when the promotion is created. Switching it off would turn a coupon
-- people hold into a private code anyone can type; switching it on would take a public promotion
-- away from everyone. Refused for everyone (admins, the service role, SQL).
CREATE OR REPLACE FUNCTION public.tg_promotions_grant_only_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.grant_only IS DISTINCT FROM OLD.grant_only THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Un cupón de disculpa se elige al crear la promoción y no se puede cambiar.',
      DETAIL = 'grant_only_frozen';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_promotions_grant_only_frozen() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER promotions_grant_only_frozen
  BEFORE UPDATE OF grant_only ON public.promotions
  FOR EACH ROW EXECUTE FUNCTION public.tg_promotions_grant_only_frozen();

-- One apology coupon per account. The phone rule is the reward_claims row (claim
-- 'missed_ride_coupon', 00658), which outlives the account. granted_by and contacted_by have no
-- foreign key, like ride_dispute_escalations (00673), so deleting a team account is never blocked.
CREATE TABLE IF NOT EXISTS public.promotion_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES public.promotions(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source = 'missed_ride'),
  granted_by uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotion_grants_user_source_key UNIQUE (user_id, source)
);
CREATE INDEX IF NOT EXISTS promotion_grants_promotion_idx ON public.promotion_grants (promotion_id);
ALTER TABLE public.promotion_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.promotion_grants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.promotion_grants TO service_role;

CREATE TABLE IF NOT EXISTS public.missed_ride_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  contacted_by uuid NOT NULL,
  contacted_at timestamptz NOT NULL DEFAULT now(),
  last_failed_ride_id uuid,
  grant_id uuid REFERENCES public.promotion_grants(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS missed_ride_contacts_user_idx ON public.missed_ride_contacts (user_id, contacted_at DESC);
ALTER TABLE public.missed_ride_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.missed_ride_contacts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.missed_ride_contacts TO service_role;

-- 2. Helpers.

-- Per person: the latest passenger request canceled with no driver after waiting
-- support_alert_after_s, how many there were, and whether the person is in the segment: an active,
-- non-test, non-team, non-system account with no ride taken (completed or disputed) created after
-- that request.
CREATE OR REPLACE FUNCTION public._missed_rider_summary(p_user_id uuid DEFAULT NULL)
 RETURNS TABLE (user_id uuid, last_failed_ride_id uuid, last_failed_at timestamptz, last_pickup text,
                last_dropoff text, failed_requests bigint, eligible boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH cfg AS (
    SELECT make_interval(secs => public.get_platform_config_numeric('support_alert_after_s', 60)::double precision) AS wait
  ), f AS (
    SELECT r.id, r.customer_id, r.canceled_at, r.pickup_address::text AS pickup, r.dropoff_address::text AS dropoff
      FROM public.rides r CROSS JOIN cfg
     WHERE r.status = 'canceled'
       AND r.driver_id IS NULL
       AND COALESCE(r.ride_mode, 'passenger') = 'passenger'
       AND r.canceled_at IS NOT NULL
       AND (p_user_id IS NULL OR r.customer_id = p_user_id)
       AND r.canceled_at - GREATEST(r.created_at, COALESCE(r.scheduled_at, r.created_at)) >= cfg.wait
  ), last AS (
    SELECT DISTINCT ON (f.customer_id) f.customer_id, f.id, f.canceled_at, f.pickup, f.dropoff
      FROM f ORDER BY f.customer_id, f.canceled_at DESC, f.id
  ), cnt AS (
    SELECT f.customer_id, count(*) AS n FROM f GROUP BY f.customer_id
  )
  SELECT l.customer_id, l.id, l.canceled_at, l.pickup, l.dropoff, c.n,
         (u.is_active
          AND NOT COALESCE(u.is_test, false)
          AND u.role::text NOT IN ('admin', 'super_admin', 'marketing', 'operator')
          AND l.customer_id NOT IN ('00000000-0000-0000-0000-000000000001'::uuid,
                                    '00000000-0000-0000-0000-000000000099'::uuid)
          AND NOT EXISTS (SELECT 1 FROM public.rides r2
                           WHERE r2.customer_id = l.customer_id AND r2.status IN ('completed', 'disputed')
                             AND r2.created_at > l.canceled_at))
    FROM last l
    JOIN cnt c ON c.customer_id = l.customer_id
    JOIN public.users u ON u.id = l.customer_id;
$function$;
REVOKE ALL ON FUNCTION public._missed_rider_summary(uuid) FROM PUBLIC, anon, authenticated;

-- The coupon an operator gives now: the newest active grant-only promotion inside its dates with
-- uses left. The page header and the grant both read it, so they always pick the same one.
CREATE OR REPLACE FUNCTION public._missed_ride_current_coupon()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT p.id
    FROM public.promotions p
   WHERE p.grant_only
     AND p.is_active
     AND (p.valid_from IS NULL OR p.valid_from <= now())
     AND (p.valid_until IS NULL OR p.valid_until > now())
     AND (p.max_uses IS NULL OR p.current_uses < p.max_uses)
   ORDER BY p.created_at DESC, p.id
   LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public._missed_ride_current_coupon() FROM PUBLIC, anon, authenticated;

-- The caller's apology coupon, only while the validator would accept it now. Returning a used one
-- would make rides_promo_grant attach it, the validator drop it, and the signup promotion never
-- apply again (rides_signup_promo skips a ride that already names a promotion).
CREATE OR REPLACE FUNCTION public._my_granted_promotion_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT p.id
    FROM public.promotion_grants g
    JOIN public.promotions p ON p.id = g.promotion_id
   WHERE g.user_id = auth.uid()
     AND g.source = 'missed_ride'
     AND p.is_active
     AND (p.valid_from IS NULL OR p.valid_from <= now())
     AND (p.valid_until IS NULL OR p.valid_until > now())
     AND (p.max_uses IS NULL OR p.current_uses < p.max_uses)
     AND NOT EXISTS (SELECT 1 FROM public.promotion_uses pu
                      WHERE pu.promotion_id = p.id AND pu.user_id = auth.uid())
     AND public._reward_claim_status(auth.uid(), 'promo:' || p.id::text) = 'free'
     AND NOT (COALESCE(p.first_ride_only, false) AND EXISTS (
           SELECT 1 FROM public.rides r WHERE r.customer_id = auth.uid() AND r.status = 'completed'));
$function$;
REVOKE ALL ON FUNCTION public._my_granted_promotion_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._my_granted_promotion_id() TO authenticated, service_role;

-- 3. The panel: the list, the coupon header, the contact.

CREATE OR REPLACE FUNCTION public.admin_missed_riders(p_view text DEFAULT 'pending', p_days integer DEFAULT 30)
 RETURNS TABLE (user_id uuid, full_name text, phone text, failed_requests bigint, last_failed_at timestamptz,
                last_failed_ride_id uuid, last_pickup text, last_dropoff text, in_segment boolean,
                contacts bigint, last_contacted_at timestamptz, last_contacted_by text,
                coupon_status text, coupon_code text, phone_already_rewarded boolean, rode_after_contact boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
DECLARE
  v_since timestamptz;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo el equipo de operaciones ve esta lista.', DETAIL = 'forbidden';
  END IF;
  IF p_view IS NULL OR p_view NOT IN ('pending', 'contacted') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Vista desconocida.', DETAIL = 'invalid_view';
  END IF;
  IF p_days IS NOT NULL AND p_days < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Período inválido.', DETAIL = 'invalid_days';
  END IF;
  v_since := CASE WHEN p_days IS NULL THEN NULL ELSE now() - make_interval(days => p_days) END;

  RETURN QUERY
  WITH s AS (
    SELECT * FROM public._missed_rider_summary(NULL)
  ), ct AS (
    SELECT c.user_id, count(*) AS n, min(c.contacted_at) AS first_at, max(c.contacted_at) AS last_at
      FROM public.missed_ride_contacts c GROUP BY c.user_id
  ), lastc AS (
    SELECT DISTINCT ON (c.user_id) c.user_id, c.contacted_by
      FROM public.missed_ride_contacts c ORDER BY c.user_id, c.contacted_at DESC, c.id
  ), picked AS (
    SELECT s.user_id FROM s LEFT JOIN ct ON ct.user_id = s.user_id
     WHERE p_view = 'pending' AND s.eligible AND ct.user_id IS NULL
       AND (v_since IS NULL OR s.last_failed_at >= v_since)
    UNION ALL
    SELECT ct.user_id FROM ct
     WHERE p_view = 'contacted' AND (v_since IS NULL OR ct.last_at >= v_since)
  )
  SELECT pk.user_id,
         u.full_name::text,
         CASE WHEN au.phone_confirmed_at IS NOT NULL AND COALESCE(au.phone, '') <> '' THEN au.phone::text END,
         COALESCE(s.failed_requests, 0)::bigint,
         s.last_failed_at,
         s.last_failed_ride_id,
         s.last_pickup,
         s.last_dropoff,
         COALESCE(s.eligible, false),
         COALESCE(ct.n, 0)::bigint,
         ct.last_at,
         cu.full_name::text,
         CASE
           WHEN g.id IS NULL THEN 'none'
           WHEN EXISTS (SELECT 1 FROM public.promotion_uses pu
                         WHERE pu.promotion_id = g.promotion_id AND pu.user_id = pk.user_id) THEN 'used'
           WHEN NOT (pr.is_active
                     AND (pr.valid_from IS NULL OR pr.valid_from <= now())
                     AND (pr.valid_until IS NULL OR pr.valid_until > now())
                     AND (pr.max_uses IS NULL OR pr.current_uses < pr.max_uses)) THEN 'unusable'
           ELSE 'granted'
         END,
         pr.code::text,
         (g.id IS NULL AND public._reward_claim_status(pk.user_id, 'missed_ride_coupon') = 'taken'),
         (ct.first_at IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.rides r3
             WHERE r3.customer_id = pk.user_id AND r3.status IN ('completed', 'disputed')
               AND r3.created_at > ct.first_at))
    FROM picked pk
    JOIN public.users u ON u.id = pk.user_id
    LEFT JOIN auth.users au ON au.id = pk.user_id
    LEFT JOIN s ON s.user_id = pk.user_id
    LEFT JOIN ct ON ct.user_id = pk.user_id
    LEFT JOIN lastc lc ON lc.user_id = pk.user_id
    LEFT JOIN public.users cu ON cu.id = lc.contacted_by
    LEFT JOIN public.promotion_grants g ON g.user_id = pk.user_id AND g.source = 'missed_ride'
    LEFT JOIN public.promotions pr ON pr.id = g.promotion_id
   ORDER BY CASE WHEN p_view = 'pending' THEN s.last_failed_at ELSE ct.last_at END DESC NULLS LAST, pk.user_id
   LIMIT 500;
END
$function$;
REVOKE ALL ON FUNCTION public.admin_missed_riders(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_missed_riders(text, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_missed_ride_coupon()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_ops_staff() THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo el equipo de operaciones ve el cupón de disculpa.', DETAIL = 'forbidden';
  END IF;
  RETURN (SELECT jsonb_build_object('id', p.id, 'code', p.code, 'type', p.type,
                                    'discount_percent', p.discount_percent, 'discount_fixed_cup', p.discount_fixed_cup,
                                    'valid_until', p.valid_until, 'max_uses', p.max_uses, 'current_uses', p.current_uses)
            FROM public.promotions p WHERE p.id = public._missed_ride_current_coupon());
END
$function$;
REVOKE ALL ON FUNCTION public.admin_missed_ride_coupon() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_missed_ride_coupon() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ops_contact_missed_rider(p_user_id uuid, p_expected_last_failed_at timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me      uuid := auth.uid();
  v_sum     record;
  v_phone   text;
  v_name    text;
  v_grant   public.promotion_grants%ROWTYPE;
  v_promo   public.promotions%ROWTYPE;
  v_coupon  uuid;
  v_claim   text;
  v_usable  boolean := false;
  v_reason  text;
  v_contact uuid;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_user_id IS NULL OR p_expected_last_failed_at IS NULL THEN
    RETURN jsonb_build_object('error', 'invalid_request');
  END IF;
  IF p_user_id = v_me THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;

  -- Two people writing at once give one coupon: the second waits here and then finds the grant.
  PERFORM 1 FROM public.users WHERE id = p_user_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;

  SELECT * INTO v_sum FROM public._missed_rider_summary(p_user_id);
  IF NOT FOUND OR NOT v_sum.eligible THEN
    RETURN jsonb_build_object('error', 'not_eligible');
  END IF;
  IF v_sum.last_failed_at IS DISTINCT FROM p_expected_last_failed_at THEN
    RETURN jsonb_build_object('error', 'missed_rider_changed', 'last_failed_at', v_sum.last_failed_at);
  END IF;

  SELECT au.phone INTO v_phone FROM auth.users au
   WHERE au.id = p_user_id AND au.phone_confirmed_at IS NOT NULL AND COALESCE(au.phone, '') <> '';
  IF v_phone IS NULL THEN
    RETURN jsonb_build_object('error', 'no_phone');
  END IF;
  SELECT u.full_name INTO v_name FROM public.users u WHERE u.id = p_user_id;

  SELECT * INTO v_grant FROM public.promotion_grants g
   WHERE g.user_id = p_user_id AND g.source = 'missed_ride';
  IF v_grant.id IS NULL THEN
    v_coupon := public._missed_ride_current_coupon();
    IF v_coupon IS NULL THEN
      v_reason := 'no_coupon_available';
    ELSE
      v_claim := public._claim_reward(p_user_id, 'missed_ride_coupon');
      IF v_claim = 'claimed' THEN
        INSERT INTO public.promotion_grants (promotion_id, user_id, source, granted_by)
        VALUES (v_coupon, p_user_id, 'missed_ride', v_me)
        RETURNING * INTO v_grant;
        v_usable := true;
      ELSIF v_claim = 'taken' THEN
        -- The phone got an apology coupon before, from this or another account.
        v_reason := 'already_given';
      ELSE
        RETURN jsonb_build_object('error', 'no_phone');
      END IF;
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.promotion_uses pu
                 WHERE pu.promotion_id = v_grant.promotion_id AND pu.user_id = p_user_id) THEN
    v_reason := 'coupon_used';
  ELSIF NOT EXISTS (SELECT 1 FROM public.promotions p
                     WHERE p.id = v_grant.promotion_id AND p.is_active
                       AND (p.valid_from IS NULL OR p.valid_from <= now())
                       AND (p.valid_until IS NULL OR p.valid_until > now())
                       AND (p.max_uses IS NULL OR p.current_uses < p.max_uses)) THEN
    v_reason := 'coupon_unusable';
  ELSE
    v_usable := true;
  END IF;

  IF v_grant.id IS NOT NULL THEN
    SELECT * INTO v_promo FROM public.promotions WHERE id = v_grant.promotion_id;
  END IF;

  INSERT INTO public.missed_ride_contacts (user_id, contacted_by, last_failed_ride_id, grant_id)
  VALUES (p_user_id, v_me, v_sum.last_failed_ride_id, v_grant.id)
  RETURNING id INTO v_contact;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values)
  VALUES (v_me, 'missed_rider_contacted', 'user', p_user_id::text,
          jsonb_build_object('contact_id', v_contact, 'grant_id', v_grant.id, 'promotion_code', v_promo.code,
                             'last_failed_ride_id', v_sum.last_failed_ride_id, 'coupon_reason', v_reason));

  RETURN jsonb_build_object(
    'success', true,
    'phone', v_phone,
    'full_name', v_name,
    'last_failed_at', v_sum.last_failed_at,
    'coupon', CASE WHEN v_usable THEN jsonb_build_object(
                'code', v_promo.code, 'type', v_promo.type, 'discount_percent', v_promo.discount_percent,
                'discount_fixed_cup', v_promo.discount_fixed_cup, 'valid_until', v_promo.valid_until) END,
    'coupon_reason', v_reason);
END
$function$;
REVOKE ALL ON FUNCTION public.ops_contact_missed_rider(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_contact_missed_rider(uuid, timestamptz) TO authenticated, service_role;

-- 4. The coupon on the person's next ride.
CREATE OR REPLACE FUNCTION public.tg_rides_promo_grant()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_promo uuid;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- Never block the ride: any error here leaves it without the coupon.
  BEGIN
    IF auth.uid() IS NULL
       OR NEW.customer_id IS DISTINCT FROM auth.uid()
       OR NEW.promo_code_id IS NOT NULL
       OR COALESCE(NEW.ride_mode, 'passenger') <> 'passenger'
       OR NEW.corporate_account_id IS NOT NULL THEN
      RETURN NEW;
    END IF;
    v_promo := public._my_granted_promotion_id();
    IF v_promo IS NULL OR public.is_admin() THEN
      RETURN NEW;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '00674 tg_rides_promo_grant: lookup failed for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  -- The validator, which fires later, applies every rule as for a typed code.
  NEW.promo_code_id := v_promo;
  RETURN NEW;
END;
$function$;
-- A trigger function needs no EXECUTE grant to fire (as 00665 did for tg_rides_signup_promo).
REVOKE ALL ON FUNCTION public.tg_rides_promo_grant() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER rides_promo_grant
  BEFORE INSERT ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_promo_grant();

-- 5. In-place patches of the live bodies (each text exactly once; skipped when already patched).
DO $patch$
DECLARE
  v_row  record;
  v_src  text;
  v_hits integer;
BEGIN
  FOR v_row IN
    SELECT f.fn::regprocedure AS fn, f.marker,
           replace(f.old_text, chr(13), '') AS old_text, replace(f.new_text, chr(13), '') AS new_text
      FROM (VALUES
        ('public.tg_rides_validate_promo_discount()',
         '00674: a grant-only promotion counts only for the person it was given to.',
         $o1$  IF v_promo IS NULL
     OR NOT v_promo.is_active$o1$,
         $n1$  IF v_promo IS NULL
     -- 00674: a grant-only promotion counts only for the person it was given to.
     OR (COALESCE(v_promo.grant_only, false) AND NOT EXISTS (
           SELECT 1 FROM public.promotion_grants g
            WHERE g.promotion_id = v_promo.id AND g.user_id = NEW.customer_id))
     OR NOT v_promo.is_active$n1$),
        ('public.validate_promo_code(text,uuid,integer)',
         '00674: a grant-only promotion is invalid for anyone it was not given to.',
         $o2$  IF v_promo IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'error', 'invalid');
  END IF;$o2$,
         $n2$  IF v_promo IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'error', 'invalid');
  END IF;

  -- 00674: a grant-only promotion is invalid for anyone it was not given to.
  IF COALESCE(v_promo.grant_only, false) AND NOT EXISTS (
    SELECT 1 FROM public.promotion_grants g
     WHERE g.promotion_id = v_promo.id AND g.user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('valid', false, 'error', 'invalid');
  END IF;$n2$),
        ('public.get_my_signup_promotion()',
         '00674: an apology coupon goes first',
         $o3$  -- The rules tg_rides_validate_promo_discount applies when the ride is$o3$,
         $n3$  -- 00674: an apology coupon goes first, as rides_promo_grant applies it before
  -- rides_signup_promo. signup_code carries the coupon's own code.
  RETURN QUERY
  SELECT p.code::text, p.type::text, p.discount_percent::numeric, p.discount_fixed_cup::integer,
         COALESCE(p.first_ride_only, false), p.valid_until::timestamptz, p.code::text
    FROM public.promotions p
   WHERE p.id = public._my_granted_promotion_id();
  IF FOUND THEN
    RETURN;
  END IF;
  -- The rules tg_rides_validate_promo_discount applies when the ride is$n3$)
      ) AS f(fn, marker, old_text, new_text)
  LOOP
    v_src := pg_get_functiondef(v_row.fn);
    CONTINUE WHEN position(v_row.marker IN v_src) > 0;
    v_hits := (length(v_src) - length(replace(v_src, v_row.old_text, ''))) / length(v_row.old_text);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '00674: % has the text to patch % times, not once', v_row.fn, v_hits;
    END IF;
    EXECUTE replace(v_src, v_row.old_text, v_row.new_text);
  END LOOP;
END
$patch$;

-- 6. Pasted from Windows (CRLF), the new bodies carry a carriage return: rewrite them without it.
DO $crlf$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._missed_rider_summary(uuid)', 'public._missed_ride_current_coupon()',
    'public._my_granted_promotion_id()', 'public.admin_missed_riders(text,integer)',
    'public.admin_missed_ride_coupon()', 'public.ops_contact_missed_rider(uuid,timestamptz)',
    'public.tg_rides_promo_grant()', 'public.tg_promotions_grant_only_frozen()']::regprocedure[]
  LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- 7. Self-checks.
DO $check$
DECLARE
  v_ours      text;
  v_signup    text;
  v_validator text;
  v_set       text;
  v_row       record;
BEGIN
  -- BEFORE ROW triggers fire in name order (C collation).
  SELECT t.tgname::text INTO v_ours FROM pg_trigger t
   WHERE t.tgrelid = 'public.rides'::regclass AND t.tgfoid = 'public.tg_rides_promo_grant()'::regprocedure
     AND t.tgenabled <> 'D' AND (t.tgtype & 7) = 7;
  SELECT min(t.tgname::text COLLATE "C") INTO v_signup FROM pg_trigger t
   WHERE t.tgrelid = 'public.rides'::regclass AND t.tgfoid = 'public.tg_rides_signup_promo()'::regprocedure
     AND t.tgenabled <> 'D' AND (t.tgtype & 7) = 7;
  SELECT min(t.tgname::text COLLATE "C") INTO v_validator FROM pg_trigger t
   WHERE t.tgrelid = 'public.rides'::regclass AND t.tgfoid = 'public.tg_rides_validate_promo_discount()'::regprocedure
     AND t.tgenabled <> 'D' AND (t.tgtype & 7) = 7;
  IF v_ours IS NULL OR v_signup IS NULL OR v_validator IS NULL
     OR NOT (v_ours COLLATE "C" < v_signup COLLATE "C" AND v_ours COLLATE "C" < v_validator COLLATE "C") THEN
    RAISE EXCEPTION '00674: rides_promo_grant has to fire before rides_signup_promo and the promo validator (ours %, signup %, validator %)',
      v_ours, v_signup, v_validator;
  END IF;

  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.tg_rides_promo_grant()'::regprocedure) THEN
    RAISE EXCEPTION '00674: tg_rides_promo_grant() must be SECURITY INVOKER: current_user tells a client insert apart';
  END IF;

  FOR v_row IN
    SELECT f.fn::regprocedure AS fn, f.client
      FROM (VALUES ('public.admin_missed_riders(text,integer)', true), ('public.admin_missed_ride_coupon()', true),
                   ('public.ops_contact_missed_rider(uuid,timestamptz)', true), ('public._my_granted_promotion_id()', true),
                   ('public._missed_rider_summary(uuid)', false), ('public._missed_ride_current_coupon()', false)) AS f(fn, client)
  LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_row.fn) THEN
      RAISE EXCEPTION '00674: % lost SECURITY DEFINER', v_row.fn;
    END IF;
    IF has_function_privilege('anon', v_row.fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_row.fn, 'EXECUTE') IS DISTINCT FROM v_row.client THEN
      RAISE EXCEPTION '00674: the EXECUTE grants of % are not what they must be', v_row.fn;
    END IF;
  END LOOP;

  FOR v_row IN
    SELECT f.fn::regprocedure AS fn, f.marker
      FROM (VALUES ('public.tg_rides_validate_promo_discount()', '00674: a grant-only promotion counts only'),
                   ('public.validate_promo_code(text,uuid,integer)', '00674: a grant-only promotion is invalid'),
                   ('public.get_my_signup_promotion()', '00674: an apology coupon goes first')) AS f(fn, marker)
  LOOP
    IF (SELECT (length(prosrc) - length(replace(prosrc, v_row.marker, ''))) / length(v_row.marker)
          FROM pg_proc WHERE oid = v_row.fn) <> 1 THEN
      RAISE EXCEPTION '00674: % does not carry its patch exactly once', v_row.fn;
    END IF;
  END LOOP;

  FOR v_row IN SELECT unnest(ARRAY['public.promotion_grants', 'public.missed_ride_contacts'])::regclass AS t LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_row.t)
       OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_row.t)
       OR has_table_privilege('anon', v_row.t, 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', v_row.t, 'SELECT,INSERT,UPDATE,DELETE')
       OR NOT (has_table_privilege('service_role', v_row.t, 'SELECT') AND has_table_privilege('service_role', v_row.t, 'INSERT')
               AND has_table_privilege('service_role', v_row.t, 'UPDATE') AND has_table_privilege('service_role', v_row.t, 'DELETE')) THEN
      RAISE EXCEPTION '00674: % is open to a client, or closed to the service role', v_row.t;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.promotions'::regclass
                  AND conname = 'promotions_grant_only_private' AND contype = 'c') THEN
    RAISE EXCEPTION '00674: a grant-only promotion could be public';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.promotions'::regclass
                  AND conname = 'promotions_grant_only_any_ride' AND contype = 'c'
                  AND position('first_ride_only' IN pg_get_constraintdef(oid)) > 0) THEN
    RAISE EXCEPTION '00674: a grant-only promotion could be first-ride-only';
  END IF;

  -- grant_only is frozen: an enabled BEFORE UPDATE row trigger (1 row + 2 before + 16 update),
  -- not SECURITY DEFINER.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.promotions'::regclass AND t.tgname = 'promotions_grant_only_frozen'
                    AND t.tgfoid = 'public.tg_promotions_grant_only_frozen()'::regprocedure
                    AND t.tgenabled <> 'D' AND (t.tgtype & 19) = 19) THEN
    RAISE EXCEPTION '00674: promotions_grant_only_frozen has to be an enabled BEFORE UPDATE row trigger';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.tg_promotions_grant_only_frozen()'::regprocedure) THEN
    RAISE EXCEPTION '00674: tg_promotions_grant_only_frozen() must not be SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.promotion_grants'::regclass AND contype = 'f'
                  AND confrelid = 'public.promotions'::regclass AND confdeltype = 'r') THEN
    RAISE EXCEPTION '00674: promotion_grants.promotion_id has to reference promotions ON DELETE RESTRICT';
  END IF;

  -- Only these functions call the ops helpers or the operator checks: 00668's nineteen, 00671's
  -- eleven, 00672's thirteen, 00673's seventeen and this migration's three.
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', '
                    ORDER BY p.proname) INTO v_set
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prosrc ~ '(is_operator|is_ops_staff|_ops_acting_on|_ops_allow|_ops_target_refusal|_ops_user_push|_ops_notice_push|_ops_is_ride_party)[[:space:]]*[(]'
    AND p.proname NOT IN ('is_operator', 'is_ops_staff', '_ops_acting_on', '_ops_allow',
      -- 00668
      '_panel_driver_churn_risk', 'admin_active_ride_context', 'admin_get_online_fleet',
      'admin_incomplete_driver_signups', 'admin_launch_pulse', 'admin_ride_assist_candidates',
      'admin_ride_assist_context', 'admin_support_waiting_rides', 'get_admin_dashboard_metrics',
      'get_admin_wallet_stats', 'get_corporate_balance', 'get_corporate_employees',
      'get_driver_utilization', 'get_peak_hours', 'get_product_failures', 'get_rides_by_day',
      'get_rides_by_payment_method', 'get_rides_by_service_type', 'get_top_drivers',
      -- 00671
      'enforce_ride_transition', 'enforce_ride_update_columns', 'tg_rides_validate_actuals',
      'complete_ride_and_pay', 'admin_offer_ride_to_driver', 'admin_assign_ride_to_driver',
      'admin_change_ride_service', 'admin_release_active_ride', 'admin_advance_active_ride',
      'admin_complete_active_ride', 'admin_cancel_ride',
      -- 00672
      'tg_driver_profiles_protect_admin_fields', 'tg_users_protect_admin_fields',
      'tg_driver_documents_protect_review', 'tg_corporate_accounts_protect_admin_fields',
      'tg_fleet_members_protect', '_ops_user_push', '_ops_target_refusal', 'ops_set_driver_status',
      'ops_review_driver_document', 'ops_add_driver_document', 'ops_log_driver_outreach',
      'ops_review_fleet_account', 'ops_review_fleet_member',
      -- 00673
      'tg_ride_disputes_protect_columns', 'admin_set_user_active', 'detect_collusion_reviews',
      'apply_collusion_sanction', 'reverse_collusion_sanction', '_ops_notice_push', '_ops_is_ride_party',
      'ops_update_ticket', 'ops_reply_ticket', 'ops_update_incident', 'ops_update_lost_item',
      'ops_update_dispute', 'ops_resolve_dispute_without_refund', 'ops_escalate_dispute',
      'admin_refund_escalated_dispute', 'ops_set_review_visibility', 'ops_resolve_fraud_alert',
      -- 00674
      'admin_missed_riders', 'admin_missed_ride_coupon', 'ops_contact_missed_rider');
  IF v_set IS NOT NULL THEN
    RAISE EXCEPTION '00674: other functions call the ops checks: %', v_set;
  END IF;

  -- Each ops function, and admin_refund_escalated_dispute as in 00673: SECURITY DEFINER, out of
  -- anon's reach, open to authenticated, and it logs.
  FOR v_row IN
    SELECT p.oid::regprocedure AS fn, p.prosecdef, p.prosrc FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND (left(p.proname, 4) = 'ops_' OR p.proname = 'admin_refund_escalated_dispute')
  LOOP
    IF NOT v_row.prosecdef
       OR has_function_privilege('anon', v_row.fn, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_row.fn, 'EXECUTE')
       OR position('INSERT INTO public.admin_actions' IN v_row.prosrc) = 0 THEN
      RAISE EXCEPTION '00674: % is not a proper ops function', v_row.fn;
    END IF;
  END LOOP;
END
$check$;
