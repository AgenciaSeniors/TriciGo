-- What the 00674 rehearsal needs beyond the 00665 scaffold, as in prod on 2026-11-02:
-- the operator role (00667), users.is_test, the ride and promotion columns 00674 reads,
-- admin_actions, and the LIVE bodies of is_ops_staff() and is_operator() (00668; run.sh S0
-- checks their md5). Run by the test superuser after the scaffold and migration 00665.
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'operator';

SET ROLE tricigo_owner;

ALTER TABLE public.users ADD COLUMN is_test boolean NOT NULL DEFAULT false;
ALTER TABLE public.promotions
  ADD COLUMN is_public boolean NOT NULL DEFAULT true,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.rides
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN canceled_at timestamptz,
  ADD COLUMN scheduled_at timestamptz,
  ADD COLUMN pickup_address text,
  ADD COLUMN dropoff_address text;

CREATE TABLE public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  old_values jsonb,
  new_values jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.admin_actions TO service_role;

-- LIVE bodies (prod, 2026-11-02).
CREATE OR REPLACE FUNCTION public.is_operator()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron. None of them is an operator, and anon may not
  -- call current_user_role() (00517). Same early return as is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() = 'operator';
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_ops_staff()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- Admins, super admins and operators (00668). No JWT subject: false, with the early return of
  -- is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin', 'operator');
END;
$function$;

RESET ROLE;
