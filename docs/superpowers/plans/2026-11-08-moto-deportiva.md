# Moto Deportiva Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Moto Deportiva" ride type that can be requested whenever a listed pilot is online and free, priced 200 CUP below a regular moto, with a permanent "Avísame" subscription that notifies subscribers when a pilot goes online, a fallback to a regular moto after 2 minutes, and a super-admin page for pilots, subscribers and an emergency switch. In the client app, the web, the driver app and the admin panel.

**Architecture:** One new service type `moto_deportiva` (row in `service_type_configs`; `is_active` is the emergency switch, on by default). Two lock tables (pilots, waitlist) reached only through SECURITY DEFINER RPCs. A helper `_md_driver_allowed(driver, service)` is patched into the three dispatch functions, so the service reaches only pilots and pilots get nothing else. An AFTER UPDATE trigger on `driver_profiles.is_online` notifies subscribers when a pilot connects. The apps read `get_moto_deportiva_status()` and map it to a card with a pure function in `@tricigo/utils`; the price is the moto estimate plus a configurable offset (`-200`), computed in the shared `getLocalFareEstimate`.

**Tech Stack:** Supabase Postgres (plpgsql, RLS), Expo/React Native (client, driver), Next.js 15 (web, admin), TypeScript, vitest, local Postgres 16 + PostGIS for the rehearsal.

**Spec:** `docs/superpowers/specs/2026-11-08-moto-deportiva-design.md`. Read it first, and read CLAUDE.md § "Tablas nuevas en public: GRANT explícito", § "Patch in-place para cambios de UNA línea en RPCs grandes", § "Cómo probar migraciones SQL de verdad sin tocar prod", § "MCP migration guard" and § "El 74 % de la gente que usa TriciGo no puede recibir un push".

**Live bodies verified on 2026-11-08 (md5 of `prosrc`):** `find_best_drivers` `ec914394abd6f03eeedffc1ae51e8db0` (5822), `notify_offline_drivers_for_searching_rides` `2a317ff22745d2bbf80c86b20b426a17` (5648), `_driver_can_serve_ride` `733f31677b6c4c146efa6434976180a8` (323). `_vehicle_types_for_service` (`5299ab645064c495257109e7e53c6e4e`) is not changed: `moto%` already maps `moto_deportiva` to motos, and the pilot filter does the rest. Re-check them before writing the migration; if any differs, stop and read the new body.

**Order of release:** migration (Tasks 1–3) → shared code (Tasks 4–5) → apps (Tasks 6–10) → docs (Task 11). The migration is harmless without the apps: no app offers the service, and the notice only reaches people who subscribed (nobody can before the apps ship). The apps tolerate the migration being absent (status RPC missing → card hidden).

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/00679_moto_deportiva.sql` (create) | Service row + bands, settings, tables, helpers, dispatch patches, status RPC, insert guard, notice trigger, RPCs |
| `supabase/tests/00679/run.sh`, `scaffold-extra.sql`, `tests.sql` (create) | Local rehearsal on top of the 00650 scaffold |
| `packages/types/src/enums.ts` (modify) | `ServiceTypeSlug` gets `'moto_deportiva'` |
| `packages/api/src/schemas.ts` (modify) | `serviceTypeSchema` gets `'moto_deportiva'` |
| `packages/utils/src/motoDeportiva.ts` + `__tests__/motoDeportiva.test.ts` (create) | Status → card mapping, fallback rule, price offset |
| `packages/api/src/services/moto-deportiva.service.ts` + test (create) | Status, waitlist, admin overview, switch, pilots, subscribers |
| `packages/api/src/services/ride.service.ts` (modify) | `getLocalFareEstimate` prices `moto_deportiva` as moto + offset |
| `apps/client/assets/vehicles/selection/moto_deportiva*.png`, `apps/web/public/images/vehicles/moto_deportiva.png` (create) | Card image |
| `apps/client/src/hooks/useMotoDeportivaStatus.ts` (create) | Polls the status while the selector is on screen |
| `apps/client/app/(tabs)/index.tsx`, `apps/client/src/hooks/useRide.ts`, `apps/client/src/utils/vehicleImages.ts` (modify) | Card, estimates, "Avísame", fallback banner |
| `apps/web/src/app/book/page.tsx`, `apps/web/src/hooks/useMotoDeportivaStatus.ts` | Same for the web |
| `apps/driver/src/components/IncomingRideCard.tsx` (+ active trip header) | "Moto Deportiva" badge |
| `apps/admin/src/app/moto-deportiva/page.tsx` (create), `packages/utils/src/adminPanelAccess.ts`, `apps/admin/src/lib/rideType.ts`, sidebar | Status, switch, pilots, subscribers |
| `packages/i18n/src/locales/{es,en,pt}/*.json` | Real copy |
| `CLAUDE.md` | New section "Moto Deportiva" |

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
-- Moto Deportiva: a ride type requestable while a listed pilot is online and free.
-- Spec: docs/superpowers/specs/2026-11-08-moto-deportiva-design.md
--
-- A. Service row (is_active = emergency switch, on) and bands: moto_standard rates with the
--    minimum fare 200 CUP lower. The app prices the trip as the moto estimate + the offset (B);
--    these rows feed only the server floor (tg_rides_validate_estimated_fare) and ceiling (00631).
-- B. Settings: price offset, visibility, notice cooldown.
-- C. Lock tables moto_deportiva_pilots and moto_deportiva_waitlist.
-- D. Helpers _moto_deportiva_is_on() and _md_driver_allowed(driver_profile_id, service_type).
-- E. md5-guarded in-place patches of find_best_drivers, notify_offline_drivers_for_searching_rides
--    and _driver_can_serve_ride.
-- F. get_moto_deportiva_status() for the apps.
-- G. BEFORE INSERT guard on rides.
-- H. AFTER UPDATE OF is_online trigger on driver_profiles: a pilot going online notifies subscribers.
-- I. RPCs: waitlist (users); overview, switch, pilots, subscribers (super admins).

-- ── A. Service and bands ─────────────────────────────────────
INSERT INTO public.service_type_configs
  (slug, name_es, name_en, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup,
   max_passengers, icon_name, is_active, per_wait_minute_rate_cup, free_wait_minutes,
   base_fare_usd, per_km_rate_usd, per_minute_rate_usd, min_fare_usd, per_wait_minute_rate_usd)
SELECT 'moto_deportiva', 'Moto Deportiva', 'Sport Motorbike',
       s.base_fare_cup, s.per_km_rate_cup, s.per_minute_rate_cup, GREATEST(s.min_fare_cup - 200, 0),
       1, s.icon_name, true, s.per_wait_minute_rate_cup, s.free_wait_minutes,
       s.base_fare_usd, s.per_km_rate_usd, s.per_minute_rate_usd,
       CASE WHEN s.min_fare_cup > 0
            THEN s.min_fare_usd * GREATEST(s.min_fare_cup - 200, 0) / s.min_fare_cup END,
       s.per_wait_minute_rate_usd
  FROM public.service_type_configs s
 WHERE s.slug = 'moto_standard'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.pricing_rules
  (zone_id, service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup,
   time_window_start, time_window_end, day_of_week, is_active, city_id,
   base_fare_usd, per_km_rate_usd, per_minute_rate_usd, min_fare_usd,
   per_wait_minute_rate_cup, per_wait_minute_rate_usd)
SELECT p.zone_id, 'moto_deportiva', p.base_fare_cup, p.per_km_rate_cup, p.per_minute_rate_cup,
       GREATEST(p.min_fare_cup - 200, 0),
       p.time_window_start, p.time_window_end, p.day_of_week, p.is_active, p.city_id,
       p.base_fare_usd, p.per_km_rate_usd, p.per_minute_rate_usd,
       CASE WHEN p.min_fare_cup > 0
            THEN p.min_fare_usd * GREATEST(p.min_fare_cup - 200, 0) / p.min_fare_cup END,
       p.per_wait_minute_rate_cup, p.per_wait_minute_rate_usd
  FROM public.pricing_rules p
 WHERE p.service_type = 'moto_standard' AND p.is_active
   AND NOT EXISTS (SELECT 1 FROM public.pricing_rules q WHERE q.service_type = 'moto_deportiva');

SELECT public.recompute_cup_from_usd_prices();

-- ── B. Settings ──────────────────────────────────────────────
INSERT INTO public.platform_config (key, value) VALUES
  ('moto_deportiva_price_offset_cup', '-200'::jsonb),
  ('moto_deportiva_show_when_unavailable', 'true'::jsonb),
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

-- moto_deportiva: only pilots. Any other service: everybody except pilots.
CREATE OR REPLACE FUNCTION public._md_driver_allowed(p_driver_profile_id uuid, p_service_type text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN p_service_type = 'moto_deportiva' THEN
      EXISTS (SELECT 1 FROM public.moto_deportiva_pilots WHERE driver_profile_id = p_driver_profile_id)
    ELSE NOT EXISTS (SELECT 1 FROM public.moto_deportiva_pilots WHERE driver_profile_id = p_driver_profile_id)
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
  c_fbd regprocedure := 'public.find_best_drivers(double precision,double precision,text,integer,integer,boolean,integer,text,numeric,integer,integer,integer,uuid)'::regprocedure;
BEGIN
  -- E1. find_best_drivers
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = c_fbd;
  IF v_md5 NOT IN ('ec914394abd6f03eeedffc1ae51e8db0', '<E1_AFTER_MD5>') THEN
    RAISE EXCEPTION '00679: find_best_drivers has an unknown body (md5 %)', v_md5;
  END IF;
  IF v_md5 = 'ec914394abd6f03eeedffc1ae51e8db0' THEN
    v_src := pg_get_functiondef(c_fbd);
    v_new := replace(v_src,
      'AND (v_vehicle_types IS NULL OR v.type = ANY(v_vehicle_types))',
      'AND (v_vehicle_types IS NULL OR v.type = ANY(v_vehicle_types))
      AND public._md_driver_allowed(dp.id, p_service_type)  -- 00679');
    IF v_new = v_src THEN RAISE EXCEPTION '00679: find_best_drivers anchor not found'; END IF;
    EXECUTE v_new;
  END IF;

  -- E2. notify_offline_drivers_for_searching_rides
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.notify_offline_drivers_for_searching_rides()'::regprocedure;
  IF v_md5 NOT IN ('2a317ff22745d2bbf80c86b20b426a17', '<E2_AFTER_MD5>') THEN
    RAISE EXCEPTION '00679: notify_offline_drivers_for_searching_rides has an unknown body (md5 %)', v_md5;
  END IF;
  IF v_md5 = '2a317ff22745d2bbf80c86b20b426a17' THEN
    v_src := pg_get_functiondef('public.notify_offline_drivers_for_searching_rides()'::regprocedure);
    -- Own group label; no vehicle branch matches it, so nobody is pushed for it.
    v_new := replace(v_src,
      'WHEN r.service_type LIKE ''moto%''     THEN ''moto''',
      'WHEN r.service_type = ''moto_deportiva'' THEN ''moto_deportiva''
        WHEN r.service_type LIKE ''moto%''     THEN ''moto''');
    v_new := replace(v_new,
      'WHEN r2.service_type LIKE ''moto%''     THEN ''moto''',
      'WHEN r2.service_type = ''moto_deportiva'' THEN ''moto_deportiva''
                 WHEN r2.service_type LIKE ''moto%''     THEN ''moto''');
    -- Pilots are never woken up for other services.
    v_new := replace(v_new,
      'AND dp.is_online = false',
      'AND dp.is_online = false
      AND public._md_driver_allowed(dp.id, v_group.label)  -- 00679');
    IF (length(v_new) - length(replace(v_new, '-- 00679', ''))) / length('-- 00679') <> 1
       OR (length(v_new) - length(replace(v_new, '''moto_deportiva'' THEN', ''))) / length('''moto_deportiva'' THEN') <> 2 THEN
      RAISE EXCEPTION '00679: notify_offline anchors not found exactly once';
    END IF;
    EXECUTE v_new;
  END IF;

  -- E3. _driver_can_serve_ride (support offers and assignments)
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public._driver_can_serve_ride(uuid,text,boolean)'::regprocedure;
  IF v_md5 NOT IN ('733f31677b6c4c146efa6434976180a8', '<E3_AFTER_MD5>') THEN
    RAISE EXCEPTION '00679: _driver_can_serve_ride has an unknown body (md5 %)', v_md5;
  END IF;
  IF v_md5 = '733f31677b6c4c146efa6434976180a8' THEN
    v_src := pg_get_functiondef('public._driver_can_serve_ride(uuid,text,boolean)'::regprocedure);
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
    v_waiting := EXISTS (SELECT 1 FROM public.moto_deportiva_waitlist WHERE user_id = auth.uid());
  END IF;

  IF NOT public._moto_deportiva_is_on() THEN
    v_status := 'off';
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

  IF v_status <> 'available' THEN
    SELECT (value #>> '{}') NOT IN ('false', 'f') INTO v_show
      FROM public.platform_config WHERE key = 'moto_deportiva_show_when_unavailable';
    IF NOT COALESCE(v_show, true) THEN v_status := 'hidden'; END IF;
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

-- ── H. Notice when a pilot goes online ───────────────────────
-- Permanent subscriptions: everybody on the list, every time, at most once per cooldown.
-- Batches of 300 ids: send-push filters with .in() (CLAUDE.md, campaigns).
-- Never blocks the pilot going online: any failure is logged and swallowed.
CREATE OR REPLACE FUNCTION public.tg_moto_deportiva_pilot_online()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
 SET lock_timeout TO '2s'
AS $function$
DECLARE
  v_key text;
  v_ids uuid[];
  v_batch uuid[];
  v_cooldown_h int;
  i int;
BEGIN
  IF NOT NEW.is_online OR COALESCE(OLD.is_online, false)
     OR NOT EXISTS (SELECT 1 FROM public.moto_deportiva_pilots WHERE driver_profile_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  BEGIN
    IF NOT public._moto_deportiva_is_on() THEN RETURN NEW; END IF;
    -- Two pilots connecting at once must not both send.
    PERFORM pg_advisory_xact_lock(hashtext('moto_deportiva_waitlist_notice'));
    v_cooldown_h := GREATEST(0, public.get_platform_config_numeric('moto_deportiva_waitlist_cooldown_h', 3))::int;
    IF EXISTS (
      SELECT 1 FROM public.platform_config
       WHERE key = 'moto_deportiva_last_waitlist_push_at'
         AND (value #>> '{}')::timestamptz > now() - make_interval(hours => v_cooldown_h)
    ) THEN
      RETURN NEW;
    END IF;
    SELECT array_agg(user_id) INTO v_ids FROM public.moto_deportiva_waitlist;
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
          'title',    '¡La Moto Deportiva está disponible!',
          'body',     'Pídela ahora en TriciGo.',
          'category', 'promo',
          'data',     jsonb_build_object('content_type', 'moto_deportiva')),
        timeout_milliseconds := 30000);
    END LOOP;
    UPDATE public.moto_deportiva_waitlist SET notified_at = now() WHERE user_id = ANY (v_ids);
    INSERT INTO public.platform_config (key, value)
    VALUES ('moto_deportiva_last_waitlist_push_at', to_jsonb(now()))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.log_rpc_attempt('moto_deportiva_waitlist_push', auth.uid(), NEW.id, 'push_failed',
      jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM));
  END;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS driver_profiles_moto_deportiva_online ON public.driver_profiles;
CREATE TRIGGER driver_profiles_moto_deportiva_online AFTER UPDATE OF is_online ON public.driver_profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_moto_deportiva_pilot_online();
REVOKE ALL ON FUNCTION public.tg_moto_deportiva_pilot_online() FROM PUBLIC, anon, authenticated;

-- ── I. RPCs ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_moto_deportiva_waitlist(p_join boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('error', 'unauthenticated'); END IF;
  IF p_join THEN
    INSERT INTO public.moto_deportiva_waitlist (user_id) VALUES (auth.uid())
    ON CONFLICT (user_id) DO NOTHING;
  ELSE
    DELETE FROM public.moto_deportiva_waitlist WHERE user_id = auth.uid();
  END IF;
  RETURN jsonb_build_object('success', true, 'waiting', p_join);
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_moto_deportiva_overview()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  RETURN jsonb_build_object(
    'active', public._moto_deportiva_is_on(),
    'status', public.get_moto_deportiva_status() ->> 'status',
    'waitlist_count', (SELECT count(*) FROM public.moto_deportiva_waitlist),
    'last_notice_at', (SELECT value #>> '{}' FROM public.platform_config WHERE key = 'moto_deportiva_last_waitlist_push_at'),
    'pilots', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'driver_profile_id', dp.id, 'full_name', u.full_name,
               'is_online', dp.is_online, 'status', dp.status) ORDER BY u.full_name)
        FROM public.moto_deportiva_pilots mp
        JOIN public.driver_profiles dp ON dp.id = mp.driver_profile_id
        JOIN public.users u ON u.id = dp.user_id), '[]'::jsonb));
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_moto_deportiva_subscribers()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  RETURN jsonb_build_object('subscribers', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'user_id', w.user_id, 'full_name', u.full_name, 'phone', u.phone,
             'subscribed_at', w.created_at, 'notified_at', w.notified_at) ORDER BY w.created_at DESC)
      FROM public.moto_deportiva_waitlist w
      JOIN public.users u ON u.id = w.user_id), '[]'::jsonb));
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_moto_deportiva_subscriber(p_user_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  DELETE FROM public.moto_deportiva_waitlist WHERE user_id = p_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_subscribed'); END IF;
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values)
  VALUES (auth.uid(), 'moto_deportiva_remove_subscriber', 'user', p_user_id::text,
          jsonb_build_object('subscribed', false));
  RETURN jsonb_build_object('success', true);
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

REVOKE ALL ON FUNCTION public.set_moto_deportiva_waitlist(boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_moto_deportiva_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_moto_deportiva_subscribers() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_remove_moto_deportiva_subscriber(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_moto_deportiva(boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_add_moto_deportiva_pilot(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_remove_moto_deportiva_pilot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_moto_deportiva_waitlist(boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_moto_deportiva_overview() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_moto_deportiva_subscribers() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_remove_moto_deportiva_subscriber(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_moto_deportiva(boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_add_moto_deportiva_pilot(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_remove_moto_deportiva_pilot(uuid) TO authenticated, service_role;

-- ── Self-checks ──────────────────────────────────────────────
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.service_type_configs WHERE slug = 'moto_deportiva') THEN
    RAISE EXCEPTION '00679: service row missing';
  END IF;
  IF (SELECT count(*) FROM public.pricing_rules WHERE service_type = 'moto_deportiva' AND is_active)
     <> (SELECT count(*) FROM public.pricing_rules WHERE service_type = 'moto_standard' AND is_active) THEN
    RAISE EXCEPTION '00679: the bands were not copied';
  END IF;
  IF has_table_privilege('anon', 'public.moto_deportiva_waitlist', 'SELECT')
     OR has_table_privilege('authenticated', 'public.moto_deportiva_waitlist', 'SELECT')
     OR has_table_privilege('authenticated', 'public.moto_deportiva_pilots', 'SELECT') THEN
    RAISE EXCEPTION '00679: lock tables are readable by clients';
  END IF;
  IF has_function_privilege('authenticated', 'public._md_driver_allowed(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00679: _md_driver_allowed is executable by clients';
  END IF;
  IF position('_md_driver_allowed' IN (SELECT prosrc FROM pg_proc WHERE oid =
       'public.find_best_drivers(double precision,double precision,text,integer,integer,boolean,integer,text,numeric,integer,integer,integer,uuid)'::regprocedure)) = 0
     OR position('_md_driver_allowed' IN (SELECT prosrc FROM pg_proc WHERE oid =
       'public._driver_can_serve_ride(uuid,text,boolean)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00679: dispatch not patched';
  END IF;
END
$check$;
```

The three `<E*_AFTER_MD5>` placeholders are filled in Task 2 Step 4 with the md5s the rehearsal prints after the first apply (so the migration can be re-applied). Do not commit the file with them.

- [ ] **Step 2:** Run `corepack pnpm@9.15.4 check:migration-grants`. Expected: PASS (both tables have GRANTs including `service_role`; no serial columns).

---

### Task 2: Local rehearsal

**Files:** Create `supabase/tests/00679/run.sh`, `supabase/tests/00679/scaffold-extra.sql`, `supabase/tests/00679/tests.sql`

The 00650 scaffold already has `driver_profiles`, `vehicles`, `find_best_drivers` and `notify_offline_drivers_for_searching_rides`. Applying migration 00650 on it yields today's live bodies (check the md5s at the top of this plan).

- [ ] **Step 1: `scaffold-extra.sql`** — what 00650's scaffold lacks: `service_type_configs` (columns and CHECK of Task 1, `slug` unique), `pricing_rules` (same), `platform_config (key text PK, value jsonb, updated_at timestamptz DEFAULT now())`, `admin_actions`, `rpc_attempt_log` + `log_rpc_attempt` (inserts a row), `recompute_cup_from_usd_prices()` (stub: `UPDATE … SET min_fare_cup = round(min_fare_usd * 330)` on both tables), `is_super_admin()` (prod body), `_user_id_by_verified_phone(text)` (stub over `auth.users` with `phone_confirmed_at IS NOT NULL`), `_driver_can_serve_ride` (live body, verbatim). Seed: `moto_standard` config + 4 bands with the prod values of 2026-11-08 (06–12 has base 0 and min 753), users SUPER (super_admin), RIDER and RIDER2 (customers), PILOT and MOTO2 (approved moto drivers, offline, active `moto` vehicle near 23.1357,-82.3666), TRIKE (approved triciclo driver, online).

- [ ] **Step 2: `tests.sql`** — each case prints `PASS name` or `FAIL name`:

| Case | Setup | Expect |
|---|---|---|
| T1 | PILOT not listed, both motos online, `find_best_drivers(…,'moto_standard',…)` | PILOT and MOTO2 |
| T2 | PILOT listed; service `moto_deportiva` | only PILOT |
| T3 | PILOT listed; service `moto_standard` | MOTO2 only |
| T4 | PILOT listed; service `triciclo_basico` and `mensajeria` | never PILOT |
| T5 | status as anon, PILOT offline | `offline`; with `show_when_unavailable = false` → `hidden` |
| T6 | PILOT online and free | `available` |
| T7 | PILOT with an `in_progress` ride | `busy` |
| T8 | a `moto_deportiva` ride `searching` created 10 s ago | `busy` |
| T9 | emergency switch off, PILOT online | `off` |
| T10 | client INSERT of a `moto_deportiva` ride when `busy` (as `authenticated`) | error DETAIL `moto_deportiva_unavailable` |
| T11 | same INSERT when `available` | ride created |
| T12 | INSERT as owner (no client role) when `offline` | ride created |
| T13 | RIDER and RIDER2 subscribe; PILOT goes offline → online | one `net.http_post` with both in `user_ids`; both still subscribed (`waiting` true); `last_waitlist_push_at` set |
| T14 | PILOT offline → online again within 3 h | no new push |
| T15 | `last_waitlist_push_at` moved 4 h back; PILOT offline → online | a second push to both (permanent subscription) |
| T16 | MOTO2 (not a pilot) offline → online | no push |
| T17 | switch off; PILOT offline → online after the cooldown | no push |
| T18 | no service key in the vault, cooldown elapsed, PILOT online | PILOT is online (UPDATE committed), one `push_failed` row |
| T19 | RIDER calls `admin_set_moto_deportiva(false)`, `admin_moto_deportiva_subscribers()`, `admin_remove_moto_deportiva_subscriber(RIDER2)` | each `{"error":"forbidden"}`, nothing changed, no `admin_actions` row |
| T20 | SUPER lists subscribers; removes RIDER2 | two rows with name and phone; then RIDER2 gone and one `admin_actions` row |
| T21 | SUPER adds PILOT by phone; adds TRIKE by phone | success / `not_an_approved_moto_driver` |
| T22 | `notify_offline_drivers_for_searching_rides()` with a searching `moto_deportiva` ride, PILOT offline | no push for that group |
| T23 | searching `moto_standard` ride, PILOT and MOTO2 offline | the push includes MOTO2, not PILOT |
| T24 | `_driver_can_serve_ride(PILOT,'moto_standard',false)` / `(PILOT,'moto_deportiva',false)` | false / true |
| T25 | anon and authenticated `SELECT` from both lock tables | permission denied |
| T26 | prices | `service_type_configs.min_fare_cup` of `moto_deportiva` = moto − 200 (±1 from the stub rounding); the 06–12 band keeps base 0 |

- [ ] **Step 3: `run.sh`** — copy the structure of `supabase/tests/00674/run.sh` (`ok`/`ko`/`run`/`val`/`err` helpers, `PGBIN`/`PGPORT`/`PGDB`, `PGCLIENTENCODING=UTF8 LC_MESSAGES=C`): create the DB, load `../00650/scaffold.sql`, apply `supabase/migrations/00650_*.sql`, check the three live md5s, load `scaffold-extra.sql`. With `none`, run `tests.sql` (RED). With the migration path: apply it twice, run `tests.sql`, apply a CRLF copy (`sed 's/$/\r/'`) in a fresh DB, and run negative proofs: (a) replace `find_best_drivers` with an unknown body → the migration aborts with `unknown body`; (b) grant SELECT on the waitlist to anon, rerun → the self-check aborts.

- [ ] **Step 4: Run RED, then GREEN, then fill the md5s**

```bash
PGBIN=<pg16 bin> PGPORT=<free port> bash supabase/tests/00679/run.sh none
```
Expected: most T* FAIL.

```bash
PGBIN=<pg16 bin> PGPORT=<free port> bash supabase/tests/00679/run.sh supabase/migrations/00679_moto_deportiva.sql
```
The first apply passes; the second aborts with `unknown body (md5 X)` for each patched function. Put each printed md5 in place of `<E1_AFTER_MD5>`, `<E2_AFTER_MD5>`, `<E3_AFTER_MD5>` and rerun. Expected: all PASS, idempotent, CRLF and negative proofs PASS.

- [ ] **Step 5: Commit** `feat(db): add Moto Deportiva service, pilots, waitlist and status`

---

### Task 3: Prod rehearsal and apply (needs explicit authorization)

- [ ] **Step 1:** Ask the user, with AskUserQuestion, for authorization to (a) run the migration in prod inside a rolled-back block and (b) apply it (CLAUDE.md § "MCP migration apply").
- [ ] **Step 2:** Rehearsal: `DO $probe$ BEGIN EXECUTE $mig$<file>$mig$; <T2, T3, T6, T10, T13 with the demo driver +5355550101 as a temporary pilot and the demo rider subscribed>; RAISE EXCEPTION 'PROBE %', <results>; END $probe$;`. The rollback cancels the enqueued push (`net.http_request_queue` is transactional). The function bodies contain `DELETE FROM`, so MCP will wait for approval: warn the user first; if it is cut twice, hand over the SQL Editor steps.
- [ ] **Step 3:** Apply. Verify by object: the three md5s from Task 2, the service row `is_active = true`, the bands copied, `has_table_privilege` checks, the trigger `driver_profiles_moto_deportiva_online` enabled, and `get_moto_deportiva_status()` as anon returns `{"status":"offline","waiting":false}` (no pilots yet).

---

### Task 4: Types, schema and the pure helpers

**Files:** Modify `packages/types/src/enums.ts:33-40`, `packages/api/src/schemas.ts:40`, `packages/utils/src/index.ts`. Create `packages/utils/src/motoDeportiva.ts`, `packages/utils/src/__tests__/motoDeportiva.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/utils/src/__tests__/motoDeportiva.test.ts
import { describe, it, expect } from 'vitest';
import {
  motoDeportivaCard, shouldOfferMotoFallback, MOTO_FALLBACK_AFTER_S,
  parseMotoDeportivaStatus, applyMotoDeportivaOffset,
} from '../motoDeportiva';

describe('motoDeportivaCard', () => {
  it('hides the card when hidden or unknown', () => {
    expect(motoDeportivaCard(null).visible).toBe(false);
    expect(motoDeportivaCard({ status: 'hidden', waiting: false }).visible).toBe(false);
  });
  it('offers Avísame while off or offline', () => {
    expect(motoDeportivaCard({ status: 'offline', waiting: false })).toEqual({
      visible: true, requestable: false, reason: 'unavailable', waitlist: 'join',
    });
    expect(motoDeportivaCard({ status: 'off', waiting: true }).waitlist).toBe('joined');
  });
  it('is busy without Avísame', () => {
    expect(motoDeportivaCard({ status: 'busy', waiting: true })).toEqual({
      visible: true, requestable: false, reason: 'busy', waitlist: 'none',
    });
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

describe('applyMotoDeportivaOffset', () => {
  it('subtracts 200 from the moto fare', () => {
    expect(applyMotoDeportivaOffset(1500, -200, 553)).toBe(1300);
  });
  it('never goes below the Moto Deportiva minimum', () => {
    expect(applyMotoDeportivaOffset(753, -200, 600)).toBe(600);
  });
  it('treats a missing or non-numeric offset as 0', () => {
    expect(applyMotoDeportivaOffset(1500, Number.NaN, 553)).toBe(1500);
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
  reason: 'unavailable' | 'busy' | null;
  waitlist: 'none' | 'join' | 'joined';
}

const VALUES: readonly MotoDeportivaStatusValue[] = ['hidden', 'off', 'offline', 'busy', 'available'];
export const MOTO_DEPORTIVA_SLUG = 'moto_deportiva' as const;
/** After this many seconds searching, the rider is offered a regular moto. */
export const MOTO_FALLBACK_AFTER_S = 120;
/** platform_config key with the CUP added to the moto fare (−200 on 2026-11-09). */
export const MOTO_DEPORTIVA_OFFSET_KEY = 'moto_deportiva_price_offset_cup';

export function parseMotoDeportivaStatus(raw: unknown): MotoDeportivaStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { status?: unknown; waiting?: unknown };
  if (typeof r.status !== 'string' || !(VALUES as readonly string[]).includes(r.status)) return null;
  return { status: r.status as MotoDeportivaStatusValue, waiting: r.waiting === true };
}

export function motoDeportivaCard(s: MotoDeportivaStatus | null): MotoDeportivaCard {
  if (!s || s.status === 'hidden') return { visible: false, requestable: false, reason: null, waitlist: 'none' };
  if (s.status === 'available') return { visible: true, requestable: true, reason: null, waitlist: 'none' };
  if (s.status === 'busy') return { visible: true, requestable: false, reason: 'busy', waitlist: 'none' };
  return { visible: true, requestable: false, reason: 'unavailable', waitlist: s.waiting ? 'joined' : 'join' };
}

export function shouldOfferMotoFallback(p: { serviceType: string | null | undefined; status: string | null | undefined; elapsedSeconds: number }): boolean {
  return p.serviceType === MOTO_DEPORTIVA_SLUG && p.status === 'searching' && p.elapsedSeconds >= MOTO_FALLBACK_AFTER_S;
}

/** The Moto Deportiva fare: the moto fare plus the offset, never below its own minimum. */
export function applyMotoDeportivaOffset(motoFareCup: number, offsetCup: number, minFareCup: number): number {
  const offset = Number.isFinite(offsetCup) ? offsetCup : 0;
  return Math.max(Math.round(motoFareCup + offset), minFareCup);
}
```

Add `export * from './motoDeportiva';` to `packages/utils/src/index.ts`.

- [ ] **Step 4:** Run the test → PASS.

- [ ] **Step 5: Type and schema.** In `packages/types/src/enums.ts` add `| 'moto_deportiva'` after `| 'moto_standard'`. In `packages/api/src/schemas.ts:40` add `'moto_deportiva'` after `'moto_standard'`. Run `corepack pnpm@9.15.4 check-types`. Every `Record<ServiceTypeSlug, …>` (6 on 2026-11-08, e.g. `apps/client/src/utils/vehicleImages.ts`) fails: add a `moto_deportiva` entry to each (`moto` assets until Task 6) and rerun until green.

- [ ] **Step 6: Commit** `feat: add moto_deportiva service type and helpers`

---

### Task 5: API service and price

**Files:** Create `packages/api/src/services/moto-deportiva.service.ts`, `packages/api/src/services/__tests__/moto-deportiva.test.ts`. Modify `packages/api/src/index.ts`, `packages/api/src/services/ride.service.ts` (`getLocalFareEstimate`, line ~298).

- [ ] **Step 1: Failing tests** (mock `getSupabaseClient` as `__tests__/fleet.test.ts` does):

```ts
it('getStatus returns null when the RPC is missing', async () => {
  mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'not found' } });
  expect(await motoDeportivaService.getStatus()).toBeNull();
});
it('getStatus parses the RPC', async () => {
  mockRpc.mockResolvedValueOnce({ data: { status: 'available', waiting: false }, error: null });
  expect(await motoDeportivaService.getStatus()).toEqual({ status: 'available', waiting: false });
});
it('removeSubscriber throws AppError on forbidden', async () => {
  mockRpc.mockResolvedValueOnce({ data: { error: 'forbidden' }, error: null });
  await expect(motoDeportivaService.removeSubscriber('u1')).rejects.toMatchObject({ code: 'MOTO_DEPORTIVA_FORBIDDEN' });
});
```

And in the ride service tests (`grep -rln "getLocalFareEstimate" packages/api/src --include=*.test.ts`), a case: with the moto estimate at 1500, `platform_config` offset `-200` and the `moto_deportiva` config minimum 553, `getLocalFareEstimate({service_type: 'moto_deportiva', …})` returns `estimated_fare_cup` 1300 and `service_type` `'moto_deportiva'`.

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Service**

```ts
// packages/api/src/services/moto-deportiva.service.ts
import { getSupabaseClient } from '../client';
import { AppError } from '../errors';
import { parseMotoDeportivaStatus, type MotoDeportivaStatus } from '@tricigo/utils';

export interface MotoDeportivaPilot { driver_profile_id: string; full_name: string | null; is_online: boolean; status: string }
export interface MotoDeportivaOverview {
  active: boolean; status: string; waitlist_count: number; last_notice_at: string | null; pilots: MotoDeportivaPilot[];
}
export interface MotoDeportivaSubscriber {
  user_id: string; full_name: string | null; phone: string | null; subscribed_at: string; notified_at: string | null;
}

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
  async subscribers(): Promise<MotoDeportivaSubscriber[]> {
    const { data, error } = await getSupabaseClient().rpc('admin_moto_deportiva_subscribers');
    return rpcResult<{ subscribers: MotoDeportivaSubscriber[] }>(data, error).subscribers;
  },
  async removeSubscriber(userId: string): Promise<void> {
    const { data, error } = await getSupabaseClient().rpc('admin_remove_moto_deportiva_subscriber', { p_user_id: userId });
    rpcResult(data, error);
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

Check the `AppError` import path against another service (`grep -n "AppError" packages/api/src/services/fleet.service.ts | head -2`). Export from `packages/api/src/index.ts` next to the other services.

- [ ] **Step 4: Price.** At the top of `getLocalFareEstimate`, before any fetch:

```ts
if (params.service_type === 'moto_deportiva') {
  const moto = await this.getLocalFareEstimate({ ...params, service_type: 'moto_standard' });
  const supabase = getSupabaseClient();
  const [{ data: cfg }, { data: svc }] = await Promise.all([
    supabase.from('platform_config').select('value').eq('key', MOTO_DEPORTIVA_OFFSET_KEY).maybeSingle(),
    supabase.from('service_type_configs').select('min_fare_cup').eq('slug', 'moto_deportiva').maybeSingle(),
  ]);
  const offset = Number(cfg?.value ?? 0);
  const minFare = svc?.min_fare_cup ?? 0;
  const fare = applyMotoDeportivaOffset(moto.estimated_fare_cup, offset, minFare);
  return { ...moto, service_type: 'moto_deportiva', estimated_fare_cup: fare, estimated_fare_trc: fare };
}
```

Adjust to the real `FareEstimate` fields (`grep -rn "interface FareEstimate" -A25 packages/types/src`): every CUP/TRC total and any fare range must carry the offset too (same amount, floored at the minimum), and `stops_surcharge_cup` stays the moto one. `platform_config` hides only secret keys from clients (00517): confirm `moto_deportiva_price_offset_cup` is readable as `anon` and `authenticated` (`SET LOCAL ROLE anon; SELECT value FROM platform_config WHERE key = …` in a rolled-back block); if not, add `offset_cup` to the JSON of `get_moto_deportiva_status` and read it from there. `ride.integration.test.ts` mocks `@tricigo/utils` whole: add the new imports to that `vi.mock`.

- [ ] **Step 5:** Run → PASS. Confirm `moto_deportiva_unavailable` reaches the UI as its Spanish MESSAGE (`grep -n "details" packages/api/src/services/ride.service.ts | head`); if `createRide` maps a list of known DETAILs, add this one.
- [ ] **Step 6: Commit** `feat(api): add Moto Deportiva service and price`

---

### Task 6: Card image

**Files:** Create `apps/client/assets/vehicles/selection/moto_deportiva.png`, `@2x`, `@3x`, and `apps/web/public/images/vehicles/moto_deportiva.png`.

- [ ] **Step 1:** Read `apps/client/assets/vehicles/selection/moto*.png` to get size, angle, colours and background (transparent). Produce a sports-bike illustration in the same style: side view, same canvas sizes, same palette, no brand, logo or model name (a designer, or the Canva image generator, then background removal).
- [ ] **Step 2:** Until the final art exists, copy `moto*.png` to `moto_deportiva*.png` so builds work, and say so in the PR.
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
  const setWaitlist = useCallback(async (join: boolean) => {
    const waiting = await motoDeportivaService.setWaitlist(join);
    setStatus((s) => (s ? { ...s, waiting } : s));
  }, []);
  return { status, card: motoDeportivaCard(status), refetch, setWaitlist };
}
```

- [ ] **Step 2: Estimates.** In `useRide.ts:501` (`allSlugs`) and `index.tsx:831` (`serviceTypes`) add `'moto_deportiva'` only when `card.requestable` (pass `card.requestable` in to the function that builds the list). A failed estimate stays `null` (already handled).
- [ ] **Step 3: Service lists.** Add `moto_deportiva` after `moto_standard` in `SERVICE_META` (`{ label: 'Moto Deportiva', desc: 'Exclusiva', maxPax: 1, slug: 'moto_deportiva' }`), `VEHICLE_ICONS`, `WEB_SERVICES`, the SERVICIOS row (`index.tsx:2879`), the vertical card list (`index.tsx:3898`) and `allServiceSlugs` (`index.tsx:4365`), rendered only when `card.visible`. Not in `DELIVERY_VEHICLES`.
- [ ] **Step 4: Card states** (vertical list and web card list), for `slug === 'moto_deportiva'` and `!card.requestable`: `opacity: 0.55`, `onPress` disabled, and in place of the price:
  - `reason === 'busy'` → `t('moto_deportiva.busy', { defaultValue: 'Ocupada · en un viaje' })`
  - `reason === 'unavailable'` → `t('moto_deportiva.unavailable', { defaultValue: 'No disponible ahora' })`, plus a small button: `waitlist === 'join'` → `t('moto_deportiva.notify_me', { defaultValue: 'Avísame' })` → `onNotifyMe()`; `'joined'` → `t('moto_deportiva.notify_joined', { defaultValue: 'Te avisaremos' })` → `setWaitlist(false)`.
  If the selected service is `moto_deportiva` and the card stops being requestable (poll), switch the selection to `moto_standard` with `setServiceType`.
- [ ] **Step 5: Permission on "Avísame".** `onNotifyMe`: read `Notifications.getPermissionsAsync()`; if `shouldSpendPushPrompt(...)` (`packages/utils/src/pushRegistration.ts`) allows it, run the app's registration (`registerPushTokenForUser`, as `useNotificationSetup` does); if denied and `canAskAgain` is false, open the existing soft-ask sheet. Then `setWaitlist(true)` whatever the answer (the inbox still gets the notice).
- [ ] **Step 6: Server rejection.** When `confirmRide` fails with `moto_deportiva_unavailable`, show its message and call `refetch()`.
- [ ] **Step 7: Fallback banner** in `SearchingView` (`index.tsx:5087`), using its `elapsedSeconds`:

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

When `offerMotoFallback`, render above the cancel button: title `t('moto_deportiva.fallback_title', { defaultValue: 'La Moto Deportiva no respondió' })`, body `t('moto_deportiva.fallback_body', { defaultValue: 'Puedes pedir una Moto normal con el mismo destino.' })`, button `t('moto_deportiva.fallback_cta', { defaultValue: 'Cambiar a Moto' })` → `switchToMoto`. The selecting view re-estimates on its own and the rider confirms the moto price. `cancelRide` runs `resetAll()`; if the draft still comes back empty, set it after a `setTimeout(0)`.
- [ ] **Step 8: Notice tap.** The push carries `data.content_type = 'moto_deportiva'`: in the client notification handler and the inbox, open the home/selection screen (`grep -rn "content_type" apps/client/src | head`).
- [ ] **Step 9:** Active ride, history and receipts: check `RideActiveView.tsx`, `apps/client/app/(tabs)/rides.tsx` and `apps/client/app/ride/[id].tsx` (grep `auto_confort`) and add the label where a map lists slugs.
- [ ] **Step 10:** `corepack pnpm@9.15.4 check-types` green; run on the phone (CLAUDE.md § "Local dev") with the migration applied and the demo driver as a temporary pilot: offline → greyed with "Avísame"; tap → permission prompt, "Te avisaremos"; pilot online → notice arrives, card requestable at moto − 200; pilot on a ride → "Ocupada"; pilot ignores the offer → banner at 2:00 → "Cambiar a Moto" lands on selection with Moto selected. Remove the demo pilot and the subscription afterwards.
- [ ] **Step 11: Commit** `feat(client): add Moto Deportiva card, waitlist and fallback`

---

### Task 8: Web

**Files:** Create `apps/web/src/hooks/useMotoDeportivaStatus.ts` (Task 7 Step 1 without `useRefreshOnFocus`: refetch on `visibilitychange` to `visible`). Modify `apps/web/src/app/book/page.tsx`.

- [ ] **Step 1:** Add `{ slug: 'moto_deportiva', abbr: 'MD', label: 'Moto Deportiva', desc: 'Exclusiva', icon: '/images/vehicles/moto_deportiva.png' }` after the moto entry (`page.tsx:51`), rendered when `card.visible`; add the slug to the estimate list (`page.tsx:624`) only when `card.requestable`. Not in the delivery lists (`page.tsx:327`, `1475`).
- [ ] **Step 2:** Same card states and server-rejection handling as Task 7. "Avísame" without a session sends to login with a return to `/book`; with a session it calls `setWaitlist(true)` (web push is not set up: the notice reaches the inbox and the person's phone if they use the app).
- [ ] **Step 3:** Fallback on the web search screen (`grep -rn "searchWaitView" apps/web/src`): same banner; "Cambiar a Moto" cancels and returns to `/book` with the same pickup/dropoff and `moto_standard` preselected (reuse how the page restores a draft, or pass them as query params).
- [ ] **Step 4:** `check-types` green; test in the browser pane. Commit `feat(web): add Moto Deportiva to booking`.

---

### Task 9: Driver badge

**Files:** Modify `apps/driver/src/components/IncomingRideCard.tsx:347-352` and the active trip header (`grep -rn "service_type" apps/driver/src/components "apps/driver/app/(tabs)/index.tsx" | head`).

- [ ] **Step 1:** In `IncomingRideCard`, when `ride.service_type === 'moto_deportiva'` show a pill `t('trip.moto_deportiva_badge', { defaultValue: 'Moto Deportiva' })` above the fare, styled like the existing status pills, and use `'flash-outline'` (extend the `vehicleIcon` condition).
- [ ] **Step 2:** Same pill in the active trip header.
- [ ] **Step 3:** `check-types` green. Commit `feat(driver): show Moto Deportiva badge`.

---

### Task 10: Admin panel

**Files:** Create `apps/admin/src/app/moto-deportiva/page.tsx`. Modify `packages/utils/src/adminPanelAccess.ts:83`, `packages/utils/src/__tests__/adminPanelAccess.test.ts`, the sidebar component (`grep -rn "'/equipo'" apps/admin/src/components | head`), `apps/admin/src/lib/rideType.ts`.

- [ ] **Step 1: Access test first.** In `adminPanelAccess.test.ts`: `/moto-deportiva` allowed for `super_admin`, denied for `admin`, `operator`, `marketing`. Run → FAIL. Set `SUPER_ADMIN_ROUTES` to `['/equipo', '/moto-deportiva']`. Run → PASS.
- [ ] **Step 2: Page** (client component, same layout primitives as `apps/admin/src/app/equipo/page.tsx`), three blocks:
  - **Estado:** the current status (`available` → "Disponible", `busy` → "Ocupada", `offline` → "Piloto desconectado", `off` → "Apagada"), the last notice time (`formatAdminDate`), and the emergency switch "Mostrar la Moto Deportiva en la app" (confirmation dialog, `setActive`, reload).
  - **Pilotos:** table (name, en línea) with "Quitar" (`removePilot`), and an input "Teléfono del piloto" + "Agregar" (`addPilot`). Errors: `phone_not_found` → "No hay ninguna cuenta con ese teléfono confirmado"; `not_an_approved_moto_driver` → "Esa cuenta no es un conductor aprobado con moto".
  - **Suscritos al aviso (N):** table from `subscribers()` (nombre, teléfono, desde, último aviso) with "Quitar del aviso" per row (confirmation, `removeSubscriber`, reload), and a name/phone filter box.
- [ ] **Step 3:** Sidebar entry "Moto Deportiva" in the super-admin group next to "Equipo". `rideType.ts`: `moto_deportiva: { key: 'rides.type_moto_deportiva', fallback: 'Moto Deportiva' }`.
- [ ] **Step 4 (only if the team approves the metrics, spec open item 1):** a fourth block "Últimos 30 días" with numbers read by a new super-admin RPC `admin_moto_deportiva_metrics()` in a new migration: subscribers now and new in the period, notices sent, Moto Deportiva requests, completed rides, canceled before pickup, changes to a regular moto (`cancellation_reason = 'moto_deportiva_fallback'`), revenue of completed rides, people whose first completed ride was a Moto Deportiva, and hours with a pilot online (from `audit_log` `is_online` changes).
- [ ] **Step 5:** `check-types` + `corepack pnpm@9.15.4 --filter @tricigo/utils test` green. Open the page in the browser pane as a super admin. Commit `feat(admin): add Moto Deportiva page`.

---

### Task 11: i18n, docs and wrap-up

- [ ] **Step 1:** Real copy in `packages/i18n/src/locales/{es,en,pt}/rider.json` (`moto_deportiva.*`), `driver.json` (`trip.moto_deportiva_badge`), `admin.json` (`rides.type_moto_deportiva`), `common.json` (`service_type.moto_deportiva`). Tuteo (`copyTuteo` runs in `pnpm test`).
- [ ] **Step 2:** Add a section "Moto Deportiva" to CLAUDE.md (after "Feature Compartir viaje"): automatic availability and the emergency switch, pilots table, `_md_driver_allowed` in the three dispatch functions with their new md5s, the status values, the insert guard, the notice trigger on `driver_profiles.is_online` (permanent subscriptions, 3 h cooldown, inbox backstop), the price (moto estimate + `moto_deportiva_price_offset_cup`, computed in `getLocalFareEstimate`; the bands only feed the server checks), the 2-minute fallback (cancel + reselect), and the `moto%` trap.
- [ ] **Step 3:** `corepack pnpm@9.15.4 check-types`, `corepack pnpm@9.15.4 test`, `check:migration-grants` green.
- [ ] **Step 4:** Commit `docs: document Moto Deportiva`, ask before pushing the branch, open the PR with: migration status, OTA needed for client and driver, open items (metrics, final image, pilot account, pilot income), and the parity checklist of CLAUDE.md.
