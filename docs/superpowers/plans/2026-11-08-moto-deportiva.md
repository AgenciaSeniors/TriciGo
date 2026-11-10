# Moto Deportiva Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Moto Deportiva" ride type that super admins switch on from the panel, offered only to listed pilots, with busy/off states, an opt-in "Avísame" push, and a fallback to a regular moto after 2 minutes, in the client app, the web, the driver app and the admin panel.

**Architecture:** One new service type `moto_deportiva` (row in `service_type_configs`, `is_active` is the switch). Two lock tables (pilots, waitlist) reached only through SECURITY DEFINER RPCs. A helper `_md_driver_allowed(driver, service)` is patched into the three dispatch functions so the service reaches only pilots and pilots get nothing else while it is on. The apps read one RPC, `get_moto_deportiva_status()`, and map it to a card with a pure function in `@tricigo/utils`.

**Tech Stack:** Supabase Postgres (plpgsql, RLS), Expo/React Native (client, driver), Next.js 15 (web, admin), TypeScript, vitest, local Postgres 16 + PostGIS for the rehearsal.

**Spec:** `docs/superpowers/specs/2026-11-08-moto-deportiva-design.md`. Read it first, and read CLAUDE.md § "Tablas nuevas en public: GRANT explícito", § "Patch in-place para cambios de UNA línea en RPCs grandes", § "Cómo probar migraciones SQL de verdad sin tocar prod" and § "MCP migration guard".

**Live bodies verified on 2026-11-08 (md5 of `prosrc`):** `find_best_drivers` `ec914394abd6f03eeedffc1ae51e8db0` (5822), `notify_offline_drivers_for_searching_rides` `2a317ff22745d2bbf80c86b20b426a17` (5648), `_driver_can_serve_ride` `733f31677b6c4c146efa6434976180a8` (323), `_vehicle_types_for_service` `5299ab645064c495257109e7e53c6e4e` (unchanged by this plan: `moto%` already maps `moto_deportiva` to motos, and the pilot filter does the rest). Re-check them before writing the migration; if any differs, stop and read the new body.

**Order of release:** migration (Task 1–3) → shared code (Task 4–5) → apps (Task 6–10) → docs (Task 11). The migration is harmless without the apps (the service is off). The apps tolerate the migration being absent (status RPC missing → card hidden).

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/00679_moto_deportiva.sql` (create) | Service row + bands, setting, tables, helpers, dispatch patches, status RPC, insert guard, waitlist push trigger, admin RPCs |
| `supabase/tests/00679/run.sh`, `scaffold-extra.sql`, `tests.sql` (create) | Local rehearsal on top of the 00650 scaffold |
| `packages/types/src/enums.ts` (modify) | `ServiceTypeSlug` gets `'moto_deportiva'` |
| `packages/api/src/schemas.ts` (modify) | `serviceTypeSchema` gets `'moto_deportiva'` |
| `packages/utils/src/motoDeportiva.ts` + `__tests__/motoDeportiva.test.ts` (create) | Pure status → card mapping and the fallback timer rule |
| `packages/api/src/services/moto-deportiva.service.ts` + test (create) | `getStatus`, `setWaitlist`, admin `overview`, `setActive`, `addPilot`, `removePilot` |
| `apps/client/assets/vehicles/selection/moto_deportiva*.png`, `apps/web/public/images/vehicles/moto_deportiva.png` (create) | Card image |
| `apps/client/src/hooks/useMotoDeportivaStatus.ts` (create) | Polls the status while the selector is on screen |
| `apps/client/app/(tabs)/index.tsx`, `apps/client/src/hooks/useRide.ts`, `apps/client/src/utils/vehicleImages.ts` (modify) | Card, estimates, fallback banner |
| `apps/web/src/app/book/page.tsx` (+ hook) (modify) | Same for the web |
| `apps/driver/src/components/IncomingRideCard.tsx` (+ active trip header) (modify) | "Moto Deportiva" badge |
| `apps/admin/src/app/moto-deportiva/page.tsx` (create), `packages/utils/src/adminPanelAccess.ts`, `apps/admin/src/lib/rideType.ts`, sidebar (modify) | Switch, pilots, waitlist count |
| `packages/i18n/src/locales/{es,en,pt}/*.json` (modify) | Real copy |
| `CLAUDE.md` (modify) | New section "Moto Deportiva" |

---

### Task 0: Confirm the migration number

- [ ] **Step 1:** Run

```bash
git fetch origin master
git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -5
for pr in $(gh pr list --state open --json number --jq '.[].number'); do gh pr view $pr --json files --jq '.files[].path' | grep supabase/migrations; done
```

Expected on 2026-11-08: master ends at `00678`, open PRs hold `00569` and `00662`. If `00679` is taken, use the next free number everywhere this plan says 00679.

---

### Task 1: Migration 00679

**Files:** Create `supabase/migrations/00679_moto_deportiva.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00679_moto_deportiva.sql
-- Moto Deportiva: a ride type super admins switch on, served only by listed pilots.
-- Spec: docs/superpowers/specs/2026-11-08-moto-deportiva-design.md
--
-- A. Service row (off) and its 4 price bands. PLACEHOLDER prices: moto_standard x 1.5 in every
--    USD column, until the team decides (open item 1 of the spec). Wait-minute rates = moto.
-- B. Setting moto_deportiva_show_when_off (default true).
-- C. Lock tables moto_deportiva_pilots and moto_deportiva_waitlist (RLS, no policies, service_role).
-- D. Helpers _moto_deportiva_is_on() and _md_driver_allowed(driver_profile_id, service_type).
-- E. In-place patches (md5-guarded) of find_best_drivers, notify_offline_drivers_for_searching_rides
--    and _driver_can_serve_ride: the service reaches only pilots, and pilots get nothing else while on.
-- F. get_moto_deportiva_status() for the apps.
-- G. BEFORE INSERT guard on rides: a client cannot create a moto_deportiva ride unless available.
-- H. AFTER UPDATE trigger on service_type_configs: switching it on pushes the waitlist.
-- I. Super-admin RPCs: overview, switch, add/remove pilot. set_moto_deportiva_waitlist for users.

-- ── A. Service and bands ─────────────────────────────────────
INSERT INTO public.service_type_configs
  (slug, name_es, name_en, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup,
   max_passengers, icon_name, is_active, per_wait_minute_rate_cup, free_wait_minutes,
   base_fare_usd, per_km_rate_usd, per_minute_rate_usd, min_fare_usd, per_wait_minute_rate_usd)
SELECT 'moto_deportiva', 'Moto Deportiva', 'Sport Motorbike',
       round(s.base_fare_cup * 1.5), round(s.per_km_rate_cup * 1.5), round(s.per_minute_rate_cup * 1.5),
       round(s.min_fare_cup * 1.5), 1, s.icon_name, false, s.per_wait_minute_rate_cup, s.free_wait_minutes,
       s.base_fare_usd * 1.5, s.per_km_rate_usd * 1.5, s.per_minute_rate_usd * 1.5, s.min_fare_usd * 1.5,
       s.per_wait_minute_rate_usd
  FROM public.service_type_configs s
 WHERE s.slug = 'moto_standard'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.pricing_rules
  (zone_id, service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup,
   time_window_start, time_window_end, day_of_week, is_active, city_id,
   base_fare_usd, per_km_rate_usd, per_minute_rate_usd, min_fare_usd,
   per_wait_minute_rate_cup, per_wait_minute_rate_usd)
SELECT p.zone_id, 'moto_deportiva', round(p.base_fare_cup * 1.5), round(p.per_km_rate_cup * 1.5),
       round(p.per_minute_rate_cup * 1.5), round(p.min_fare_cup * 1.5),
       p.time_window_start, p.time_window_end, p.day_of_week, p.is_active, p.city_id,
       p.base_fare_usd * 1.5, p.per_km_rate_usd * 1.5, p.per_minute_rate_usd * 1.5, p.min_fare_usd * 1.5,
       p.per_wait_minute_rate_cup, p.per_wait_minute_rate_usd
  FROM public.pricing_rules p
 WHERE p.service_type = 'moto_standard' AND p.is_active
   AND NOT EXISTS (SELECT 1 FROM public.pricing_rules q WHERE q.service_type = 'moto_deportiva');

SELECT public.recompute_cup_from_usd_prices();

-- ── B. Setting ───────────────────────────────────────────────
INSERT INTO public.platform_config (key, value)
VALUES ('moto_deportiva_show_when_off', 'true'::jsonb),
       ('moto_deportiva_waitlist_cooldown_h', '3'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── C. Lock tables ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.moto_deportiva_pilots (
  driver_profile_id uuid PRIMARY KEY REFERENCES public.driver_profiles(id) ON DELETE CASCADE,
  added_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.moto_deportiva_pilots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.moto_deportiva_pilots FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.moto_deportiva_pilots TO service_role;

CREATE TABLE IF NOT EXISTS public.moto_deportiva_waitlist (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);
ALTER TABLE public.moto_deportiva_waitlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.moto_deportiva_waitlist FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.moto_deportiva_waitlist TO service_role;

-- ── D. Helpers ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._moto_deportiva_is_on()
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE((SELECT is_active FROM public.service_type_configs WHERE slug = 'moto_deportiva'), false)
$function$;

-- true when this driver may take a ride of this service:
--  * moto_deportiva: only pilots;
--  * anything else: everybody except pilots while moto_deportiva is on.
CREATE OR REPLACE FUNCTION public._md_driver_allowed(p_driver_profile_id uuid, p_service_type text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN p_service_type = 'moto_deportiva' THEN
      EXISTS (SELECT 1 FROM public.moto_deportiva_pilots WHERE driver_profile_id = p_driver_profile_id)
    ELSE NOT (
      public._moto_deportiva_is_on()
      AND EXISTS (SELECT 1 FROM public.moto_deportiva_pilots WHERE driver_profile_id = p_driver_profile_id))
  END
$function$;
REVOKE ALL ON FUNCTION public._moto_deportiva_is_on() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._md_driver_allowed(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._moto_deportiva_is_on() TO service_role;
GRANT EXECUTE ON FUNCTION public._md_driver_allowed(uuid, text) TO service_role;

-- ── E. Dispatch patches (live body, md5-guarded, idempotent) ─
DO $patch$
DECLARE
  v_md5 text; v_src text; v_new text;
BEGIN
  -- E1. find_best_drivers
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid =
    'public.find_best_drivers(double precision,double precision,text,integer,integer,boolean,integer,text,numeric,integer,integer,integer,uuid)'::regprocedure;
  IF v_md5 <> 'ec914394abd6f03eeedffc1ae51e8db0' AND v_md5 <> '<E1_AFTER_MD5>' THEN
    RAISE EXCEPTION '00679: find_best_drivers has an unknown body (md5 %)', v_md5;
  END IF;
  IF v_md5 = 'ec914394abd6f03eeedffc1ae51e8db0' THEN
    SELECT pg_get_functiondef('public.find_best_drivers(double precision,double precision,text,integer,integer,boolean,integer,text,numeric,integer,integer,integer,uuid)'::regprocedure) INTO v_src;
    v_new := replace(v_src,
      'AND (v_vehicle_types IS NULL OR v.type = ANY(v_vehicle_types))',
      'AND (v_vehicle_types IS NULL OR v.type = ANY(v_vehicle_types))
      AND public._md_driver_allowed(dp.id, p_service_type)  -- 00679');
    IF v_new = v_src THEN RAISE EXCEPTION '00679: find_best_drivers anchor not found'; END IF;
    EXECUTE v_new;
  END IF;

  -- E2. notify_offline_drivers_for_searching_rides
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.notify_offline_drivers_for_searching_rides()'::regprocedure;
  IF v_md5 <> '2a317ff22745d2bbf80c86b20b426a17' AND v_md5 <> '<E2_AFTER_MD5>' THEN
    RAISE EXCEPTION '00679: notify_offline_drivers_for_searching_rides has an unknown body (md5 %)', v_md5;
  END IF;
  IF v_md5 = '2a317ff22745d2bbf80c86b20b426a17' THEN
    SELECT pg_get_functiondef('public.notify_offline_drivers_for_searching_rides()'::regprocedure) INTO v_src;
    -- moto_deportiva gets its own group label; no vehicle branch matches it, so nobody is pushed for it.
    v_new := replace(v_src,
      'WHEN r.service_type LIKE ''moto%''     THEN ''moto''',
      'WHEN r.service_type = ''moto_deportiva'' THEN ''moto_deportiva''
        WHEN r.service_type LIKE ''moto%''     THEN ''moto''');
    v_new := replace(v_new,
      'WHEN r2.service_type LIKE ''moto%''     THEN ''moto''',
      'WHEN r2.service_type = ''moto_deportiva'' THEN ''moto_deportiva''
                 WHEN r2.service_type LIKE ''moto%''     THEN ''moto''');
    -- Pilots are not woken up for other services while moto_deportiva is on.
    v_new := replace(v_new,
      'AND dp.is_online = false',
      'AND dp.is_online = false
      AND public._md_driver_allowed(dp.id, v_group.label)  -- 00679');
    IF (length(v_new) - length(replace(v_new, '00679', ''))) / 5 <> 1
       OR (length(v_new) - length(replace(v_new, '''moto_deportiva'' THEN', ''))) / length('''moto_deportiva'' THEN') <> 2 THEN
      RAISE EXCEPTION '00679: notify_offline anchors not found exactly once';
    END IF;
    EXECUTE v_new;
  END IF;

  -- E3. _driver_can_serve_ride (support offer/assign)
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public._driver_can_serve_ride(uuid,text,boolean)'::regprocedure;
  IF v_md5 <> '733f31677b6c4c146efa6434976180a8' AND v_md5 <> '<E3_AFTER_MD5>' THEN
    RAISE EXCEPTION '00679: _driver_can_serve_ride has an unknown body (md5 %)', v_md5;
  END IF;
  IF v_md5 = '733f31677b6c4c146efa6434976180a8' THEN
    SELECT pg_get_functiondef('public._driver_can_serve_ride(uuid,text,boolean)'::regprocedure) INTO v_src;
    v_new := replace(v_src,
      'AND (NOT p_is_delivery OR v.accepts_cargo IS TRUE)',
      'AND (NOT p_is_delivery OR v.accepts_cargo IS TRUE)
      AND public._md_driver_allowed(p_driver_id, p_service_type)  -- 00679');
    IF v_new = v_src THEN RAISE EXCEPTION '00679: _driver_can_serve_ride anchor not found'; END IF;
    EXECUTE v_new;
  END IF;
END
$patch$;

-- ── F. Status for the apps ───────────────────────────────────
-- {status: hidden|off|offline|busy|available, waiting: bool}. Never positions or ids.
CREATE OR REPLACE FUNCTION public.get_moto_deportiva_status()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_show boolean;
  v_status text;
  v_waiting boolean := false;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    v_waiting := EXISTS (SELECT 1 FROM public.moto_deportiva_waitlist
                          WHERE user_id = auth.uid() AND notified_at IS NULL);
  END IF;

  IF NOT public._moto_deportiva_is_on() THEN
    SELECT (value #>> '{}') NOT IN ('false', 'f') INTO v_show
      FROM public.platform_config WHERE key = 'moto_deportiva_show_when_off';
    v_status := CASE WHEN COALESCE(v_show, true) THEN 'off' ELSE 'hidden' END;
  ELSIF EXISTS (
    SELECT 1 FROM public.moto_deportiva_pilots mp
    JOIN public.driver_profiles dp ON dp.id = mp.driver_profile_id
    WHERE dp.is_online AND dp.status = 'approved' AND NOT dp.is_on_break
      AND NOT EXISTS (SELECT 1 FROM public.rides r WHERE r.driver_id = dp.id
                       AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress','arrived_at_destination'))
  ) AND NOT EXISTS (
    -- Someone already asked for it in the last 150 s: the pilot is about to be busy.
    SELECT 1 FROM public.rides r WHERE r.service_type = 'moto_deportiva' AND r.status = 'searching'
      AND r.created_at > now() - interval '150 seconds'
  ) THEN
    v_status := 'available';
  ELSIF EXISTS (
    SELECT 1 FROM public.moto_deportiva_pilots mp
    JOIN public.driver_profiles dp ON dp.id = mp.driver_profile_id
    WHERE dp.is_online AND dp.status = 'approved'
  ) THEN
    v_status := 'busy';
  ELSE
    v_status := 'offline';
  END IF;

  RETURN jsonb_build_object('status', v_status, 'waiting', v_waiting);
END
$function$;
REVOKE ALL ON FUNCTION public.get_moto_deportiva_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_moto_deportiva_status() TO anon, authenticated, service_role;

-- ── G. Insert guard ──────────────────────────────────────────
-- SECURITY INVOKER on purpose: current_user tells a client write from a server one.
CREATE OR REPLACE FUNCTION public.tg_rides_moto_deportiva_guard()
 RETURNS trigger LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.service_type <> 'moto_deportiva' OR current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.ride_mode, 'passenger') <> 'passenger'
     OR NEW.corporate_account_id IS NOT NULL
     OR (NEW.scheduled_at IS NOT NULL AND NEW.scheduled_at > now())
     OR (public.get_moto_deportiva_status() ->> 'status') <> 'available' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'La Moto Deportiva no está disponible en este momento.',
      DETAIL  = 'moto_deportiva_unavailable';
  END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS rides_moto_deportiva_guard ON public.rides;
CREATE TRIGGER rides_moto_deportiva_guard BEFORE INSERT ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_moto_deportiva_guard();

-- ── H. Waitlist push when it is switched on ──────────────────
-- A trigger, not the RPC, so switching it from the pricing page also pushes.
-- Batches of 300 ids: send-push filters with .in() (CLAUDE.md, campaigns).
CREATE OR REPLACE FUNCTION public.tg_moto_deportiva_switched_on()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_key text;
  v_ids uuid[];
  v_batch uuid[];
  i int;
BEGIN
  IF NEW.slug <> 'moto_deportiva' OR NOT NEW.is_active OR OLD.is_active THEN
    RETURN NEW;
  END IF;
  -- At most one notice per cooldown window (spec, decided 2026-11-09).
  IF EXISTS (
    SELECT 1 FROM public.platform_config
     WHERE key = 'moto_deportiva_last_waitlist_push_at'
       AND (value #>> '{}')::timestamptz > now() - make_interval(
             hours => GREATEST(0, public.get_platform_config_numeric('moto_deportiva_waitlist_cooldown_h', 3))::int)
  ) THEN
    RETURN NEW;
  END IF;
  BEGIN
    SELECT array_agg(user_id) INTO v_ids FROM public.moto_deportiva_waitlist WHERE notified_at IS NULL;
    IF v_ids IS NULL THEN RETURN NEW; END IF;
    v_key := public.get_service_role_key();
    IF COALESCE(v_key, '') = '' THEN RAISE EXCEPTION 'moto_deportiva_no_service_key'; END IF;
    FOR i IN 1 .. array_length(v_ids, 1) BY 300 LOOP
      v_batch := v_ids[i : i + 299];
      PERFORM public.cron_http_post('moto-deportiva-waitlist',
        url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object('Content-Type', 'application/json',
                     'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
        body    := jsonb_build_object(
          'user_ids', to_jsonb(v_batch),
          'title',    '¡La Moto Deportiva está activa!',
          'body',     'Pídela ahora en TriciGo.',
          'category', 'promo',
          'data',     jsonb_build_object('content_type', 'moto_deportiva')),
        timeout_milliseconds := 30000);
    END LOOP;
    UPDATE public.moto_deportiva_waitlist SET notified_at = now()
     WHERE notified_at IS NULL AND user_id = ANY (v_ids);
    INSERT INTO public.platform_config (key, value)
    VALUES ('moto_deportiva_last_waitlist_push_at', to_jsonb(now()))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.log_rpc_attempt('moto_deportiva_waitlist_push', auth.uid(), NULL::uuid, 'push_failed',
      jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM));
  END;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS service_type_configs_moto_deportiva_on ON public.service_type_configs;
CREATE TRIGGER service_type_configs_moto_deportiva_on AFTER UPDATE OF is_active ON public.service_type_configs
  FOR EACH ROW EXECUTE FUNCTION public.tg_moto_deportiva_switched_on();
REVOKE ALL ON FUNCTION public.tg_moto_deportiva_switched_on() FROM PUBLIC, anon, authenticated;

-- ── I. RPCs ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_moto_deportiva_waitlist(p_join boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('error', 'unauthenticated'); END IF;
  IF p_join THEN
    INSERT INTO public.moto_deportiva_waitlist (user_id) VALUES (auth.uid())
    ON CONFLICT (user_id) DO UPDATE SET notified_at = NULL, created_at = now();
  ELSE
    DELETE FROM public.moto_deportiva_waitlist WHERE user_id = auth.uid();
  END IF;
  RETURN jsonb_build_object('success', true, 'waiting', p_join);
END
$function$;
REVOKE ALL ON FUNCTION public.set_moto_deportiva_waitlist(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_moto_deportiva_waitlist(boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_moto_deportiva_overview()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  RETURN jsonb_build_object(
    'active', public._moto_deportiva_is_on(),
    'status', public.get_moto_deportiva_status() ->> 'status',
    'waitlist_pending', (SELECT count(*) FROM public.moto_deportiva_waitlist WHERE notified_at IS NULL),
    'pilots', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'driver_profile_id', dp.id, 'full_name', u.full_name,
               'is_online', dp.is_online, 'status', dp.status) ORDER BY u.full_name)
        FROM public.moto_deportiva_pilots mp
        JOIN public.driver_profiles dp ON dp.id = mp.driver_profile_id
        JOIN public.users u ON u.id = dp.user_id), '[]'::jsonb));
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_moto_deportiva(p_active boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_old boolean;
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  SELECT is_active INTO v_old FROM public.service_type_configs WHERE slug = 'moto_deportiva' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_installed'); END IF;
  IF v_old = p_active THEN RETURN jsonb_build_object('success', true, 'active', p_active); END IF;
  UPDATE public.service_type_configs SET is_active = p_active, updated_at = now() WHERE slug = 'moto_deportiva';
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
  VALUES (auth.uid(), 'moto_deportiva_switch', 'service_type', 'moto_deportiva',
          jsonb_build_object('is_active', v_old), jsonb_build_object('is_active', p_active));
  RETURN jsonb_build_object('success', true, 'active', p_active);
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_add_moto_deportiva_pilot(p_phone text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_user uuid; v_dp uuid;
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  v_user := public._user_id_by_verified_phone(p_phone);
  IF v_user IS NULL THEN RETURN jsonb_build_object('error', 'phone_not_found'); END IF;
  SELECT dp.id INTO v_dp FROM public.driver_profiles dp
   WHERE dp.user_id = v_user AND dp.status = 'approved'
     AND EXISTS (SELECT 1 FROM public.vehicles v WHERE v.driver_id = dp.id AND v.is_active AND v.type = 'moto');
  IF v_dp IS NULL THEN RETURN jsonb_build_object('error', 'not_an_approved_moto_driver'); END IF;
  INSERT INTO public.moto_deportiva_pilots (driver_profile_id, added_by) VALUES (v_dp, auth.uid())
  ON CONFLICT (driver_profile_id) DO NOTHING;
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values)
  VALUES (auth.uid(), 'moto_deportiva_add_pilot', 'driver_profile', v_dp::text, jsonb_build_object('pilot', true));
  RETURN jsonb_build_object('success', true, 'driver_profile_id', v_dp);
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_moto_deportiva_pilot(p_driver_profile_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  DELETE FROM public.moto_deportiva_pilots WHERE driver_profile_id = p_driver_profile_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_a_pilot'); END IF;
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values)
  VALUES (auth.uid(), 'moto_deportiva_remove_pilot', 'driver_profile', p_driver_profile_id::text,
          jsonb_build_object('pilot', false));
  RETURN jsonb_build_object('success', true);
END
$function$;

REVOKE ALL ON FUNCTION public.admin_moto_deportiva_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_moto_deportiva(boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_add_moto_deportiva_pilot(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_remove_moto_deportiva_pilot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_moto_deportiva_overview() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_moto_deportiva(boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_add_moto_deportiva_pilot(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_remove_moto_deportiva_pilot(uuid) TO authenticated, service_role;

-- ── Self-checks ──────────────────────────────────────────────
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.service_type_configs WHERE slug = 'moto_deportiva') THEN
    RAISE EXCEPTION '00679: service row missing';
  END IF;
  IF (SELECT count(*) FROM public.pricing_rules WHERE service_type = 'moto_deportiva' AND is_active) <> 4 THEN
    RAISE EXCEPTION '00679: expected 4 active price bands';
  END IF;
  IF (SELECT min_fare_cup FROM public.service_type_configs WHERE slug = 'moto_deportiva') <= 0 THEN
    RAISE EXCEPTION '00679: min_fare_cup was not derived';
  END IF;
  IF has_table_privilege('anon', 'public.moto_deportiva_waitlist', 'SELECT')
     OR has_table_privilege('authenticated', 'public.moto_deportiva_pilots', 'SELECT') THEN
    RAISE EXCEPTION '00679: lock tables are readable by clients';
  END IF;
  IF has_function_privilege('authenticated', 'public._md_driver_allowed(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00679: _md_driver_allowed is executable by clients';
  END IF;
  IF position('_md_driver_allowed' IN (SELECT prosrc FROM pg_proc WHERE oid =
       'public.find_best_drivers(double precision,double precision,text,integer,integer,boolean,integer,text,numeric,integer,integer,integer,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00679: find_best_drivers not patched';
  END IF;
END
$check$;
```

The three `<E*_AFTER_MD5>` placeholders are filled in Task 2 Step 4 with the md5s the rehearsal prints after the first apply (so the migration can be re-applied). Do not commit the file with them.

- [ ] **Step 2: Check the GRANT rule**

Run: `corepack pnpm@9.15.4 check:migration-grants`
Expected: PASS (both tables have GRANTs including `service_role`; no serial columns).

---

### Task 2: Local rehearsal

**Files:** Create `supabase/tests/00679/run.sh`, `supabase/tests/00679/scaffold-extra.sql`, `supabase/tests/00679/tests.sql`

The 00650 scaffold already has `driver_profiles`, `vehicles`, `find_best_drivers` and `notify_offline_drivers_for_searching_rides`. Applying migration 00650 on it yields today's live bodies (check: the md5s at the top of this plan).

- [ ] **Step 1: `scaffold-extra.sql`** — what 00650's scaffold lacks: `service_type_configs` (columns of Task 1, `slug` unique), `pricing_rules`, `platform_config (key text PK, value jsonb, updated_at timestamptz)`, `admin_actions`, `rpc_attempt_log` + `log_rpc_attempt` (insert row), `recompute_cup_from_usd_prices()` (stub: `UPDATE service_type_configs SET min_fare_cup = round(min_fare_usd * 400)` and the same for `pricing_rules`), `is_super_admin()` (body from prod above), `_user_id_by_verified_phone(text)` (stub: lookup in `auth.users` where `phone_confirmed_at IS NOT NULL`), `_driver_can_serve_ride` and `_vehicle_types_for_service` (live bodies above, verbatim), seed rows: `moto_standard` config + 4 bands with the prod values of 2026-11-08, users SUPER (super_admin), RIDER (customer), PILOT and MOTO2 (drivers, approved, online, active `moto` vehicle near 23.1357,-82.3666), TRIKE (triciclo driver).

- [ ] **Step 2: `tests.sql`** — each case prints `PASS name` or `FAIL name`:

| Case | Setup | Expect |
|---|---|---|
| T1 | switch off, `find_best_drivers(…,'moto_standard',…)` | PILOT and MOTO2 |
| T2 | switch off, service `moto_deportiva` | nobody when PILOT is not listed; only PILOT once listed |
| T3 | switch on, service `moto_standard` | MOTO2 only (PILOT excluded) |
| T4 | switch on, service `triciclo_basico` | TRIKE, never PILOT |
| T5 | status as anon, switch off, setting true / false | `off` / `hidden` |
| T6 | switch on, PILOT online and free | `available` |
| T7 | PILOT with an `in_progress` ride | `busy` |
| T8 | PILOT offline | `offline` |
| T9 | a `moto_deportiva` ride `searching` created 10 s ago | `busy` |
| T10 | client INSERT of a `moto_deportiva` ride when `busy` (as `authenticated`) | error DETAIL `moto_deportiva_unavailable` |
| T11 | same INSERT when `available` | ride created |
| T12 | INSERT as owner (no client role) when `off` | ride created (server writes are not blocked) |
| T13 | RIDER joins waitlist, SUPER switches on | one `net.http_post` row with RIDER in `user_ids`, `notified_at` set |
| T14 | switch off and on again without re-joining | no second push |
| T14b | RIDER re-joins, switch off and on within 3 h | no push (cooldown); after setting `moto_deportiva_last_waitlist_push_at` 4 h back, the push goes out |
| T15 | RIDER calls `admin_set_moto_deportiva(true)` | `{"error":"forbidden"}`, `is_active` unchanged, no `admin_actions` row |
| T16 | SUPER adds PILOT by phone; adds TRIKE by phone | success / `not_an_approved_moto_driver` |
| T17 | `notify_offline_drivers_for_searching_rides()` with a searching `moto_deportiva` ride and PILOT offline | no push for the deportiva group |
| T18 | switch on, searching `moto_standard` ride, PILOT offline | the push excludes PILOT |
| T19 | `_driver_can_serve_ride(PILOT,'moto_standard',false)` with switch on | false; MOTO2 true |
| T20 | anon `SELECT` from both lock tables | permission denied |

- [ ] **Step 3: `run.sh`** — copy `supabase/tests/00674/run.sh` structure (`ok`/`ko`/`run`/`val`/`err` helpers, `PGBIN`/`PGPORT`/`PGDB`): create DB, load `../00650/scaffold.sql`, apply `supabase/migrations/00650_*.sql`, check the three live md5s, load `scaffold-extra.sql`; with `none` run `tests.sql` (RED); with the migration path, apply it twice, run `tests.sql`, apply a CRLF copy (`sed 's/$/\r/'`) in a fresh DB, and run negative proofs: (a) alter `find_best_drivers` body to an unknown one → migration aborts with `unknown body`; (b) grant SELECT on the waitlist to anon after applying → the self-check block aborts.

- [ ] **Step 4: Run RED, then GREEN, then fill the md5s**

```bash
PGBIN=<pg16 bin> PGPORT=<free port> bash supabase/tests/00679/run.sh none
```
Expected: most T* FAIL (no service, no functions).

```bash
PGBIN=<pg16 bin> PGPORT=<free port> bash supabase/tests/00679/run.sh supabase/migrations/00679_moto_deportiva.sql
```
The first apply passes; the second aborts with `unknown body (md5 X)` for each patched function. Put each printed md5 in place of `<E1_AFTER_MD5>`, `<E2_AFTER_MD5>`, `<E3_AFTER_MD5>` and rerun. Expected: all PASS, idempotent, CRLF and negative proofs PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00679_moto_deportiva.sql supabase/tests/00679
git commit -m "feat(db): add Moto Deportiva service, pilots and status"
```

---

### Task 3: Prod rehearsal and apply (needs explicit authorization)

- [ ] **Step 1:** Ask the user, with AskUserQuestion, for authorization to (a) run the migration in prod inside a rolled-back block and (b) apply it. Quote CLAUDE.md § "MCP migration apply".
- [ ] **Step 2:** Rehearsal: `DO $probe$ BEGIN EXECUTE $mig$<file>$mig$; <T3, T6, T10, T15 with the demo driver +5355550101 as a temporary pilot>; RAISE EXCEPTION 'PROBE %', <results>; END $probe$;` The migration has no `DROP`/`DELETE` of data except `DROP TRIGGER IF EXISTS` (new names) and the waitlist `DELETE` inside a function body, so MCP may wait for approval: warn the user first; if it is cut twice, hand over the SQL Editor steps.
- [ ] **Step 3:** Apply. Verify by object: the three md5s from Task 2, the service row `is_active = false`, 4 bands, `has_table_privilege` checks, `get_moto_deportiva_status()` as anon returns `{"status":"off","waiting":false}`.

---

### Task 4: Types, schema and the pure mapping

**Files:** Modify `packages/types/src/enums.ts:33-40`, `packages/api/src/schemas.ts:40`. Create `packages/utils/src/motoDeportiva.ts`, `packages/utils/src/__tests__/motoDeportiva.test.ts`, modify `packages/utils/src/index.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/utils/src/__tests__/motoDeportiva.test.ts
import { describe, it, expect } from 'vitest';
import { motoDeportivaCard, shouldOfferMotoFallback, MOTO_FALLBACK_AFTER_S, parseMotoDeportivaStatus } from '../motoDeportiva';

describe('motoDeportivaCard', () => {
  it('hides the card when hidden or unknown', () => {
    expect(motoDeportivaCard(null).visible).toBe(false);
    expect(motoDeportivaCard({ status: 'hidden', waiting: false }).visible).toBe(false);
  });
  it('shows an off card with the waitlist button', () => {
    expect(motoDeportivaCard({ status: 'off', waiting: false })).toEqual({
      visible: true, requestable: false, reason: 'off', waitlist: 'join',
    });
    expect(motoDeportivaCard({ status: 'off', waiting: true }).waitlist).toBe('joined');
  });
  it('is not requestable while busy or offline', () => {
    expect(motoDeportivaCard({ status: 'busy', waiting: false })).toEqual({
      visible: true, requestable: false, reason: 'busy', waitlist: 'none',
    });
    expect(motoDeportivaCard({ status: 'offline', waiting: false }).requestable).toBe(false);
  });
  it('is requestable when available', () => {
    expect(motoDeportivaCard({ status: 'available', waiting: false })).toEqual({
      visible: true, requestable: true, reason: null, waitlist: 'none',
    });
  });
});

describe('parseMotoDeportivaStatus', () => {
  it('accepts the RPC shape and rejects anything else', () => {
    expect(parseMotoDeportivaStatus({ status: 'busy', waiting: true })).toEqual({ status: 'busy', waiting: true });
    expect(parseMotoDeportivaStatus({ status: 'weird' })).toBeNull();
    expect(parseMotoDeportivaStatus(null)).toBeNull();
  });
});

describe('shouldOfferMotoFallback', () => {
  it('waits 120 s and only for a searching moto_deportiva ride', () => {
    expect(MOTO_FALLBACK_AFTER_S).toBe(120);
    expect(shouldOfferMotoFallback({ serviceType: 'moto_deportiva', status: 'searching', elapsedSeconds: 119 })).toBe(false);
    expect(shouldOfferMotoFallback({ serviceType: 'moto_deportiva', status: 'searching', elapsedSeconds: 120 })).toBe(true);
    expect(shouldOfferMotoFallback({ serviceType: 'moto_standard', status: 'searching', elapsedSeconds: 500 })).toBe(false);
    expect(shouldOfferMotoFallback({ serviceType: 'moto_deportiva', status: 'accepted', elapsedSeconds: 500 })).toBe(false);
  });
});
```

- [ ] **Step 2:** Run `corepack pnpm@9.15.4 --filter @tricigo/utils test -- motoDeportiva` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/utils/src/motoDeportiva.ts
export type MotoDeportivaStatusValue = 'hidden' | 'off' | 'offline' | 'busy' | 'available';
export interface MotoDeportivaStatus { status: MotoDeportivaStatusValue; waiting: boolean }
export interface MotoDeportivaCard {
  visible: boolean;
  requestable: boolean;
  reason: 'off' | 'offline' | 'busy' | null;
  waitlist: 'none' | 'join' | 'joined';
}

const VALUES: readonly MotoDeportivaStatusValue[] = ['hidden', 'off', 'offline', 'busy', 'available'];
export const MOTO_DEPORTIVA_SLUG = 'moto_deportiva' as const;
/** After this many seconds searching, the rider is offered a regular moto. */
export const MOTO_FALLBACK_AFTER_S = 120;

export function parseMotoDeportivaStatus(raw: unknown): MotoDeportivaStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { status?: unknown; waiting?: unknown };
  if (typeof r.status !== 'string' || !(VALUES as readonly string[]).includes(r.status)) return null;
  return { status: r.status as MotoDeportivaStatusValue, waiting: r.waiting === true };
}

export function motoDeportivaCard(s: MotoDeportivaStatus | null): MotoDeportivaCard {
  if (!s || s.status === 'hidden') return { visible: false, requestable: false, reason: null, waitlist: 'none' };
  if (s.status === 'available') return { visible: true, requestable: true, reason: null, waitlist: 'none' };
  if (s.status === 'off') return { visible: true, requestable: false, reason: 'off', waitlist: s.waiting ? 'joined' : 'join' };
  return { visible: true, requestable: false, reason: s.status, waitlist: 'none' };
}

export function shouldOfferMotoFallback(p: { serviceType: string | null | undefined; status: string | null | undefined; elapsedSeconds: number }): boolean {
  return p.serviceType === MOTO_DEPORTIVA_SLUG && p.status === 'searching' && p.elapsedSeconds >= MOTO_FALLBACK_AFTER_S;
}
```

Add `export * from './motoDeportiva';` to `packages/utils/src/index.ts`.

- [ ] **Step 4:** Run the test → PASS.

- [ ] **Step 5: Type and schema.** In `packages/types/src/enums.ts` add `| 'moto_deportiva'` after `| 'moto_standard'`. In `packages/api/src/schemas.ts:40` add `'moto_deportiva'` after `'moto_standard'`. Run `corepack pnpm@9.15.4 check-types`. Every `Record<ServiceTypeSlug, …>` (6 today, e.g. `apps/client/src/utils/vehicleImages.ts`) now fails: add a `moto_deportiva` entry to each, using `moto` assets until Task 6 lands, and rerun until green.

- [ ] **Step 6: Commit** `feat: add moto_deportiva service type and status mapping`

---

### Task 5: API service

**Files:** Create `packages/api/src/services/moto-deportiva.service.ts`, `packages/api/src/services/__tests__/moto-deportiva.test.ts`; export from `packages/api/src/index.ts`.

- [ ] **Step 1: Failing test** (mock `getSupabaseClient` as the other service tests do, e.g. `__tests__/fleet.test.ts`):

```ts
it('getStatus returns null when the RPC is missing', async () => {
  mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'not found' } });
  expect(await motoDeportivaService.getStatus()).toBeNull();
});
it('getStatus parses the RPC', async () => {
  mockRpc.mockResolvedValueOnce({ data: { status: 'available', waiting: false }, error: null });
  expect(await motoDeportivaService.getStatus()).toEqual({ status: 'available', waiting: false });
});
it('setActive throws AppError on forbidden', async () => {
  mockRpc.mockResolvedValueOnce({ data: { error: 'forbidden' }, error: null });
  await expect(motoDeportivaService.setActive(true)).rejects.toMatchObject({ code: 'MOTO_DEPORTIVA_FORBIDDEN' });
});
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/api/src/services/moto-deportiva.service.ts
import { getSupabaseClient } from '../client';
import { AppError } from '../errors';
import { parseMotoDeportivaStatus, type MotoDeportivaStatus } from '@tricigo/utils';

export interface MotoDeportivaPilot { driver_profile_id: string; full_name: string | null; is_online: boolean; status: string }
export interface MotoDeportivaOverview { active: boolean; status: string; waitlist_pending: number; pilots: MotoDeportivaPilot[] }

function rpcResult<T>(data: unknown, error: { message: string } | null): T {
  if (error) throw new AppError(error.message, 'MOTO_DEPORTIVA_FAILED', 500);
  const d = data as { error?: string } | null;
  if (d && typeof d === 'object' && typeof d.error === 'string') {
    throw new AppError(d.error, `MOTO_DEPORTIVA_${d.error.toUpperCase()}`, 400);
  }
  return data as T;
}

export const motoDeportivaService = {
  /** null when the migration is not applied or the call fails: the apps hide the card. */
  async getStatus(): Promise<MotoDeportivaStatus | null> {
    const { data, error } = await getSupabaseClient().rpc('get_moto_deportiva_status');
    if (error) return null;
    return parseMotoDeportivaStatus(data);
  },
  async setWaitlist(join: boolean): Promise<boolean> {
    const { data, error } = await getSupabaseClient().rpc('set_moto_deportiva_waitlist', { p_join: join });
    return rpcResult<{ waiting: boolean }>(data, error).waiting;
  },
  async overview(): Promise<MotoDeportivaOverview> {
    const { data, error } = await getSupabaseClient().rpc('admin_moto_deportiva_overview');
    return rpcResult<MotoDeportivaOverview>(data, error);
  },
  async setActive(active: boolean): Promise<void> {
    const { data, error } = await getSupabaseClient().rpc('admin_set_moto_deportiva', { p_active: active });
    rpcResult(data, error);
  },
  async addPilot(phone: string): Promise<void> {
    const { data, error } = await getSupabaseClient().rpc('admin_add_moto_deportiva_pilot', { p_phone: phone });
    rpcResult(data, error);
  },
  async removePilot(driverProfileId: string): Promise<void> {
    const { data, error } = await getSupabaseClient().rpc('admin_remove_moto_deportiva_pilot', { p_driver_profile_id: driverProfileId });
    rpcResult(data, error);
  },
};
```

Check the import path of `AppError` against another service (`grep -n "AppError" packages/api/src/services/fleet.service.ts | head -2`) and use the same one. Add `export * from './services/moto-deportiva.service';` to `packages/api/src/index.ts` next to the other service exports.

- [ ] **Step 4:** Run → PASS. `createRide` already turns a P0001 with DETAIL into an `AppError` for other guards; confirm `moto_deportiva_unavailable` reaches the UI as its Spanish MESSAGE (`grep -n "details" packages/api/src/services/ride.service.ts | head`), and if the mapping is a list of known DETAILs, add this one.
- [ ] **Step 5: Commit** `feat(api): add Moto Deportiva service`

---

### Task 6: Card image

**Files:** Create `apps/client/assets/vehicles/selection/moto_deportiva.png`, `@2x`, `@3x`, and `apps/web/public/images/vehicles/moto_deportiva.png`.

- [ ] **Step 1:** Read the existing `apps/client/assets/vehicles/selection/moto.png` (and `@2x`/`@3x`) to get size, angle, colours and background (transparent). Produce a sports-bike illustration in the same style: side view, same canvas sizes, same palette, no brand, logo or model name. Tools: a designer, or the Canva image generator in this session, then remove the background.
- [ ] **Step 2:** Until the final art exists, copy `moto*.png` to `moto_deportiva*.png` so builds work, and note it in the PR.
- [ ] **Step 3:** Point the `moto_deportiva` entries added in Task 4 Step 5 to the new files. Commit `feat: add Moto Deportiva card image`.

---

### Task 7: Client app

**Files:** Create `apps/client/src/hooks/useMotoDeportivaStatus.ts`. Modify `apps/client/app/(tabs)/index.tsx`, `apps/client/src/hooks/useRide.ts`.

- [ ] **Step 1: Hook**

```ts
// apps/client/src/hooks/useMotoDeportivaStatus.ts
import { useCallback, useEffect, useState } from 'react';
import { motoDeportivaService } from '@tricigo/api';
import { motoDeportivaCard, type MotoDeportivaStatus } from '@tricigo/utils';
import { useRefreshOnFocus } from './useRefreshOnFocus';

const POLL_MS = 30_000;

export function useMotoDeportivaStatus(enabled: boolean) {
  const [status, setStatus] = useState<MotoDeportivaStatus | null>(null);
  const refetch = useCallback(async () => {
    setStatus(await motoDeportivaService.getStatus());
  }, []);
  useRefreshOnFocus(refetch);
  useEffect(() => {
    if (!enabled) return;
    void refetch();
    const id = setInterval(() => void refetch(), POLL_MS);
    return () => clearInterval(id);
  }, [enabled, refetch]);
  const toggleWaitlist = useCallback(async () => {
    if (!status) return;
    const waiting = await motoDeportivaService.setWaitlist(!status.waiting);
    setStatus({ ...status, waiting });
  }, [status]);
  return { status, card: motoDeportivaCard(status), refetch, toggleWaitlist };
}
```

- [ ] **Step 2: Estimates.** In `useRide.ts:501` (`allSlugs`) and `index.tsx:831` (`serviceTypes`), add `'moto_deportiva'` only when the card is requestable: pass the status in, or filter with `motoDeportivaCard(...).requestable`. A failed estimate stays `null` (already handled).
- [ ] **Step 3: Service lists.** Add `moto_deportiva` after `moto_standard` in: `SERVICE_META` (`{ label: 'Moto Deportiva', desc: 'Exclusiva', maxPax: 1, slug: 'moto_deportiva' }`), `VEHICLE_ICONS`, `WEB_SERVICES`, the SERVICIOS row (`index.tsx:2879`), the vertical card list (`index.tsx:3898`) and `allServiceSlugs` (`index.tsx:4365`). In each list, render it only when `card.visible`. Not in `DELIVERY_VEHICLES` (passengers only).
- [ ] **Step 4: Card states** in the vertical list and the web card list: when `slug === 'moto_deportiva'` and `!card.requestable`, render the card with `opacity: 0.55`, disable `onPress`, and in place of the price show:
  - `reason === 'busy'` → `t('moto_deportiva.busy', { defaultValue: 'Ocupada · en un viaje' })`
  - `reason === 'off' | 'offline'` → `t('moto_deportiva.unavailable', { defaultValue: 'No disponible ahora' })`
  - `waitlist === 'join'` → a small button `t('moto_deportiva.notify_me', { defaultValue: 'Avísame' })` calling `toggleWaitlist`; `'joined'` → `t('moto_deportiva.notify_joined', { defaultValue: 'Te avisaremos' })` (tap again leaves the list).
  If the selected service is `moto_deportiva` and the card stops being requestable (poll), switch the selection to `moto_standard` with `setServiceType`.
- [ ] **Step 4b: Push permission on "Avísame".** Before `toggleWaitlist` joins, read the permission with `Notifications.getPermissionsAsync()`; if `shouldSpendPushPrompt(...)` (`packages/utils/src/pushRegistration.ts`) says the prompt can be spent, call the same registration the app uses (`registerPushTokenForUser` via `useNotificationSetup`); if it is denied and cannot ask again, open the existing soft-ask sheet. Join the waitlist whatever the answer: the inbox still gets the notice.
- [ ] **Step 5: Server rejection.** When `confirmRide` fails with `moto_deportiva_unavailable`, show its message and call `refetch()`.
- [ ] **Step 6: Fallback banner** in `SearchingView` (`index.tsx:5087`), using the existing `elapsedSeconds`:

```tsx
const offerMotoFallback = shouldOfferMotoFallback({
  serviceType: activeRide?.service_type, status: activeRide?.status, elapsedSeconds,
});
const switchToMoto = useCallback(async () => {
  const saved = useRideStore.getState().draft;
  await cancelRide('moto_deportiva_fallback');   // free while searching
  useRideStore.setState({ draft: { ...saved, serviceType: 'moto_standard' }, flowStep: 'selecting' });
}, [cancelRide]);
```

Render, when `offerMotoFallback`, a card above the cancel button: `t('moto_deportiva.fallback_title', { defaultValue: 'La Moto Deportiva no respondió' })`, body `t('moto_deportiva.fallback_body', { defaultValue: 'Puedes pedir una Moto normal con el mismo destino.' })`, button `t('moto_deportiva.fallback_cta', { defaultValue: 'Cambiar a Moto' })` → `switchToMoto`. The selecting view re-estimates on its own and the rider confirms the new price. Verify after `cancelRide` that `resetAll` ran before the `setState` (it is awaited); if the draft still comes back empty, set it after a `setTimeout(0)`.
- [ ] **Step 7:** Active ride, history and receipts read `SERVICE_META`/`vehicleSelectionImages`; check `RideActiveView.tsx`, `rides.tsx` and `apps/client/app/ride/[id].tsx` (grep `auto_confort`) and add the label where a map lists slugs.
- [ ] **Step 8:** `corepack pnpm@9.15.4 check-types` green; run the client on the phone (CLAUDE.md § "Local dev") with the migration applied and the demo driver as a temporary pilot: off → greyed with "Avísame"; on + pilot online → requestable; pilot on a ride → "Ocupada"; pilot ignores the offer → banner at 2:00 → "Cambiar a Moto" lands on selection with Moto selected. Remove the demo pilot afterwards.
- [ ] **Step 9: Commit** `feat(client): add Moto Deportiva card, waitlist and fallback`

---

### Task 8: Web

**Files:** Create `apps/web/src/hooks/useMotoDeportivaStatus.ts` (same as Task 7 Step 1 without `useRefreshOnFocus`: refetch on `visibilitychange` to `visible`). Modify `apps/web/src/app/book/page.tsx`.

- [ ] **Step 1:** Add `{ slug: 'moto_deportiva', abbr: 'MD', label: 'Moto Deportiva', desc: 'Exclusiva', icon: '/images/vehicles/moto_deportiva.png' }` after the moto entry at `page.tsx:51`, rendered only when `card.visible`; add the slug to the estimate list at `page.tsx:624` only when `card.requestable`. Not in the delivery vehicle list (`page.tsx:327`, `1475`).
- [ ] **Step 2:** Same card states, waitlist button (needs a session: without one, the button sends to login) and server-rejection handling as Task 7.
- [ ] **Step 3:** Fallback on the web tracking/search screen: find where the web shows a searching ride (`grep -rn "searchWaitView" apps/web/src`) and add the same banner; "Cambiar a Moto" cancels and returns to `/book` with the same pickup/dropoff and `moto_standard` preselected (reuse how the page restores a draft, or pass them as query params).
- [ ] **Step 4:** `check-types` green; test in the browser pane against prod data. Commit `feat(web): add Moto Deportiva to booking`.

---

### Task 9: Driver badge

**Files:** Modify `apps/driver/src/components/IncomingRideCard.tsx:347-352` and the active trip header (`grep -rn "service_type" apps/driver/src/components/trip* apps/driver/app/(tabs)/index.tsx | head`).

- [ ] **Step 1:** In `IncomingRideCard`, when `ride.service_type === 'moto_deportiva'` show a pill `t('trip.moto_deportiva_badge', { defaultValue: 'Moto Deportiva' })` above the fare, styled like the existing status pills (orange background, white text), and use `'flash-outline'` as the icon (extend the `vehicleIcon` condition).
- [ ] **Step 2:** Same pill in the active trip header.
- [ ] **Step 3:** `check-types` green. Commit `feat(driver): show Moto Deportiva badge`.

---

### Task 10: Admin panel

**Files:** Create `apps/admin/src/app/moto-deportiva/page.tsx`. Modify `packages/utils/src/adminPanelAccess.ts:83`, `packages/utils/src/__tests__/adminPanelAccess.test.ts`, the sidebar component (`grep -rn "'/equipo'" apps/admin/src/components | head`), `apps/admin/src/lib/rideType.ts`.

- [ ] **Step 1: Access test first.** In `adminPanelAccess.test.ts` add: `/moto-deportiva` allowed for `super_admin`, denied for `admin`, `operator`, `marketing`. Run → FAIL. Change `SUPER_ADMIN_ROUTES` to `['/equipo', '/moto-deportiva']`. Run → PASS.
- [ ] **Step 2: Page** (client component, same layout primitives as `apps/admin/src/app/equipo/page.tsx`): loads `motoDeportivaService.overview()`; shows
  - a large switch "Moto Deportiva activa / apagada" with the current `status` ("Disponible", "Ocupada", "Piloto desconectado", "Apagada"); toggling asks for confirmation, calls `setActive`, reloads;
  - "Personas esperando el aviso: N" (`waitlist_pending`);
  - pilots table (name, online, status) with "Quitar" (`removePilot`), and an input "Teléfono del piloto" + "Agregar" (`addPilot`), mapping errors `phone_not_found` → "No hay ninguna cuenta con ese teléfono confirmado", `not_an_approved_moto_driver` → "Esa cuenta no es un conductor aprobado con moto".
- [ ] **Step 3:** Sidebar entry "Moto Deportiva" in the super-admin group next to "Equipo". `rideType.ts`: `moto_deportiva: { key: 'rides.type_moto_deportiva', fallback: 'Moto Deportiva' }`.
- [ ] **Step 4:** `check-types` + `corepack pnpm@9.15.4 --filter @tricigo/utils test` green. Open the page in the browser pane as a super admin and toggle on/off once with no pilots listed (no rider can request it: status `offline`). Commit `feat(admin): add Moto Deportiva page`.

---

### Task 11: i18n, docs and wrap-up

- [ ] **Step 1:** Add real copy to `packages/i18n/src/locales/{es,en,pt}/rider.json` (`moto_deportiva.*` keys from Tasks 7–8), `driver.json` (`trip.moto_deportiva_badge`), `admin.json` (`rides.type_moto_deportiva`), `common.json` `service_type.moto_deportiva`. Tuteo (the `copyTuteo` test runs in `pnpm test`).
- [ ] **Step 2:** Add a section "Moto Deportiva" to CLAUDE.md (after "Feature Compartir viaje"): what it is, the switch (`admin_set_moto_deportiva` / trigger push), pilots table, `_md_driver_allowed` patched into the three dispatch functions with their new md5s, the status values, the insert guard, the 2-minute fallback (cancel + reselect, rider confirms new price), placeholder prices (moto × 1.5) and how to change them (new migration on the USD columns + `recompute_cup_from_usd_prices()`), and the `moto%` trap.
- [ ] **Step 3:** `corepack pnpm@9.15.4 check-types`, `corepack pnpm@9.15.4 test`, `check:migration-grants` all green.
- [ ] **Step 4:** Commit `docs: document Moto Deportiva`, push the branch (ask first), open the PR with the body listing: migration status, OTA needed for client/driver, open items (price, metrics, final image, show-when-off choice, pilot account), and the parity checklist of CLAUDE.md.
