-- 00650: a driver's vehicle is reviewed before it earns rides, Confort
-- bookings only go to Confort vehicles, and what a driver writes about their
-- documents and selfie checks cannot pose as reviewed.
--
-- Measured in prod on 2026-10-10 as the store-review demo driver (approved,
-- triciclo), inside a rolled-back block:
--
-- 1. vehicles had no trigger at all. The driver changed their own vehicle to
--    Confort with a new plate, and at once received Confort and Auto offers
--    instead of triciclo ones; they also added a second active vehicle (a moto)
--    and received moto offers too. The "Editar vehículo" screen says "Pendiente
--    de verificación" after saving, but nothing was pending: the admin never
--    saw the change. Now, for a signed-in driver who is not an admin:
--    - changing the type or the plate of an active vehicle of an APPROVED
--      driver sends the driver back to review (under_review, offline), which
--      is what the screen promised; the admin approves again from the panel,
--      as with any review. Not while a ride is in progress, and not while
--      suspended (support does it). Make, model, year, color, capacity, photo
--      and cargo settings save as before;
--    - an approved or suspended driver cannot add a vehicle (the app never
--      does: drivers edit the one they have);
--    - a driver cannot move a vehicle to another account, nor activate or
--      deactivate one (the app never does either);
--    - before approval, registering a vehicle deactivates the one registered
--      before, so a retried or redone onboarding keeps a single active vehicle
--      (the admin reads one; dispatch would use all of them).
--    A driver who was approved before keeps the identity the admin already
--    checked while back in review (identity number, criminal record).
--
-- 2. 00263 made Confort bookings go only to Confort vehicles; 00326 copied an
--    older body of find_best_drivers and silently put plain Auto vehicles back
--    (and 00336/00524 kept it). A rider paying Confort (Auto x 1.3) could get a
--    standard car: one of the three offers of a Confort booking in prod went to
--    an Auto. Confort bookings now go only to Confort vehicles; Auto bookings
--    keep going to Auto and Confort (the driver sees the fare and decides).
--    The reactivation push for offline drivers follows the same rule.
--
-- 3. A driver could insert a document row pointing at ANY file of the
--    driver-documents bucket (another driver's license, for instance), and the
--    admin would review it as this driver's. Every one of the 1,029 rows in
--    prod points inside its own driver's folder (driver-docs/<driver_id>/),
--    which is where the app uploads; a client insert must too.
--
-- 4. selfie_checks: a driver could insert a check already 'passed' with a
--    0.99 face match score, shown as such in the admin panel. A client insert
--    now always starts pending, without a result (only verify-selfie, with the
--    service role, or an admin records one). The table has no rows today.
--
-- 5. anon and authenticated lose TRUNCATE and TRIGGER on these tables (as in
--    00634), anon loses every write, and signed-in users lose DELETE (no
--    policy allows one) and every write on driver_contracts (only
--    generate-driver-contract writes it, with the service role).
--
-- Rehearsal: supabase/tests/00650/run.sh (local Postgres 16 + PostGIS, live bodies).

SET lock_timeout = '10s';

-- 0. Refuse to replace bodies this migration does not know ---------------------
DO $guard$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_proc
  WHERE oid = 'public.tg_driver_documents_protect_review()'::regprocedure;
  IF v_md5 NOT IN ('83b86da7634898190e9deaf438e1d6c9', '1fa394a57d0c9f63ae4f80c77e443f82') THEN
    RAISE EXCEPTION '00650: unexpected body of tg_driver_documents_protect_review (md5 %): not replaced', v_md5;
  END IF;
  IF to_regprocedure('public.tg_vehicles_client_guard()') IS NOT NULL THEN
    SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_proc
    WHERE oid = 'public.tg_vehicles_client_guard()'::regprocedure;
    IF v_md5 <> 'e73b942bf8f3cebb15de8cd8d2b46ae2' THEN
      RAISE EXCEPTION '00650: tg_vehicles_client_guard exists with an unknown body (md5 %): not replaced', v_md5;
    END IF;
  END IF;
  IF to_regprocedure('public.tg_selfie_checks_protect_insert()') IS NOT NULL THEN
    SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_proc
    WHERE oid = 'public.tg_selfie_checks_protect_insert()'::regprocedure;
    IF v_md5 <> '5360caa8539a974900342ddebf5a1698' THEN
      RAISE EXCEPTION '00650: tg_selfie_checks_protect_insert exists with an unknown body (md5 %): not replaced', v_md5;
    END IF;
  END IF;
END
$guard$;

-- Patches a live body: md5 checked before (old) or already patched (new); each
-- old text must appear exactly once. Literals lose \r, so a CRLF paste works.
CREATE OR REPLACE FUNCTION pg_temp.patch_00650(p_fn regprocedure, p_old_md5 text, p_new_md5 text, p_pairs text[])
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_md5 text;
  v_def text;
  v_old text;
  v_new text;
  i int;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = p_fn;
  IF v_md5 = p_new_md5 THEN
    RETURN;
  ELSIF v_md5 IS DISTINCT FROM p_old_md5 THEN
    RAISE EXCEPTION '00650: unexpected body of % (md5 %): not patched', p_fn, v_md5;
  END IF;
  v_def := pg_get_functiondef(p_fn);
  FOR i IN 1 .. array_length(p_pairs, 1) / 2 LOOP
    v_old := replace(p_pairs[2 * i - 1], chr(13), '');
    v_new := replace(p_pairs[2 * i], chr(13), '');
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION '00650: % does not carry exactly once: %', p_fn, v_old;
    END IF;
    v_def := replace(v_def, v_old, v_new);
  END LOOP;
  EXECUTE v_def;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = p_fn;
  IF v_md5 IS DISTINCT FROM p_new_md5 THEN
    RAISE EXCEPTION '00650: % patched to an unexpected body (md5 %)', p_fn, v_md5;
  END IF;
END
$fn$;

-- 1a. The driver-profile guard lets the vehicle guard send a driver back to
--     review, and keeps a re-reviewed driver's checked identity ---------------
SELECT pg_temp.patch_00650(
  'public.tg_driver_profiles_protect_admin_fields()'::regprocedure,
  'd32c7b58038d3c5658d7388392f56925', 'ccded3e1847c164327dd049c9391ffde',
  ARRAY[
$old1$  IF is_admin() THEN
    RETURN NEW;
  END IF;
$old1$,
$new1$  -- 00650: a vehicle change by an approved driver sends the profile back to
  -- review. tg_vehicles_client_guard sets this setting to the profile id around
  -- its own UPDATE (status -> under_review, is_online -> false); clients cannot
  -- set app.* settings.
  IF coalesce(current_setting('app.vehicle_rereview', true), '') = NEW.id::text THEN
    RETURN NEW;
  END IF;

  IF is_admin() THEN
    RETURN NEW;
  END IF;
$new1$,
$old2$      NEW.status := OLD.status;
    END IF;
    NEW.is_financially_eligible := OLD.is_financially_eligible;
$old2$,
$new2$      NEW.status := OLD.status;
    END IF;
    -- 00650: a driver approved before (back in review after a vehicle change)
    -- keeps the identity the admin already checked.
    IF OLD.approved_at IS NOT NULL THEN
      NEW.identity_number         := OLD.identity_number;
      NEW.has_criminal_record     := OLD.has_criminal_record;
      NEW.criminal_record_details := OLD.criminal_record_details;
    END IF;
    NEW.is_financially_eligible := OLD.is_financially_eligible;
$new2$
  ]);

-- 2. Confort bookings go only to Confort vehicles ---------------------------------
SELECT pg_temp.patch_00650(
  'public.find_best_drivers(double precision,double precision,text,integer,integer,boolean,integer,text,numeric,integer,integer,integer,uuid)'::regprocedure,
  '53a6b5d68be18d5369445986a83e2fa9', 'ec914394abd6f03eeedffc1ae51e8db0',
  ARRAY[
$old3$    WHEN p_service_type LIKE 'auto%'     THEN ARRAY['auto'::vehicle_type, 'confort'::vehicle_type]
$old3$,
$new3$    -- 00650: the rider of a Confort booking pays Confort, so only Confort
    -- vehicles get it (00263; lost in 00326). Auto bookings also go to
    -- Confort drivers, who see the fare in the offer.
    WHEN p_service_type = 'auto_confort' THEN ARRAY['confort'::vehicle_type]
    WHEN p_service_type LIKE 'auto%'     THEN ARRAY['auto'::vehicle_type, 'confort'::vehicle_type]
$new3$
  ]);

SELECT pg_temp.patch_00650(
  'public.notify_offline_drivers_for_searching_rides()'::regprocedure,
  '39582fd79f216e6002e028fa25c4dc96', '2a317ff22745d2bbf80c86b20b426a17',
  ARRAY[
$old4$        WHEN r.service_type LIKE 'auto%'     THEN 'auto'
$old4$,
$new4$        WHEN r.service_type = 'auto_confort' THEN 'confort'
        WHEN r.service_type LIKE 'auto%'     THEN 'auto'
$new4$,
$old5$                 WHEN r2.service_type LIKE 'auto%'     THEN 'auto'
$old5$,
$new5$                 WHEN r2.service_type = 'auto_confort' THEN 'confort'
                 WHEN r2.service_type LIKE 'auto%'     THEN 'auto'
$new5$,
$old6$        OR (v_group.label = 'auto'    AND v.type IN ('auto', 'confort'))
$old6$,
$new6$        OR (v_group.label = 'auto'    AND v.type IN ('auto', 'confort'))
        OR (v_group.label = 'confort' AND v.type = 'confort')
$new6$
  ]);

-- 3. A driver's document points inside their own folder ---------------------------
CREATE OR REPLACE FUNCTION public.tg_driver_documents_protect_review()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    IF TG_OP = 'INSERT' THEN
      -- 00650: the app uploads to driver-docs/<driver_id>/...; a row pointing
      -- anywhere else (another driver's license) would be reviewed as this
      -- driver's document.
      IF NEW.storage_path IS NULL
         OR left(NEW.storage_path, length('driver-docs/' || NEW.driver_id::text || '/'))
            <> 'driver-docs/' || NEW.driver_id::text || '/'
         OR position('..' IN NEW.storage_path) > 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001',
          MESSAGE = 'No se pudo guardar el documento. Vuelve a subirlo desde la app.',
          DETAIL = 'document_path_not_own';
      END IF;
      NEW.is_verified := false;
      NEW.verified_by := NULL;
      NEW.verified_at := NULL;
      NEW.rejection_reason := NULL;
      NEW.verification_notes := NULL;
      NEW.face_match_score := NULL;
      NEW.liveness_passed := NULL;
    ELSE
      NEW.is_verified := OLD.is_verified;
      NEW.verified_by := OLD.verified_by;
      NEW.verified_at := OLD.verified_at;
      NEW.rejection_reason := OLD.rejection_reason;
      NEW.verification_notes := OLD.verification_notes;
      NEW.face_match_score := OLD.face_match_score;
      NEW.liveness_passed := OLD.liveness_passed;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- 1b. The vehicle guard ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_vehicles_client_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_status text;
BEGIN
  -- Admins, the service role, cron and SQL are not limited, nor is this
  -- function's own deactivation of older vehicles (below).
  IF auth.uid() IS NULL OR public.is_admin()
     OR coalesce(current_setting('app.vehicles_internal', true), '') = '1' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.driver_id IS DISTINCT FROM OLD.driver_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'Un vehículo no se puede pasar a otra cuenta.',
        DETAIL = 'vehicle_owner_locked';
    END IF;
    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'Para activar o desactivar un vehículo, escribe a soporte.',
        DETAIL = 'vehicle_active_locked';
    END IF;
  END IF;

  -- Locks the profile: the status read here holds until the end, and the
  -- change below serializes with any other write to it.
  SELECT dp.status::text INTO v_status
  FROM driver_profiles dp WHERE dp.id = NEW.driver_id
  FOR UPDATE;

  -- Not approved yet: the admin reviews the vehicle with the rest of the
  -- profile. A registration keeps a single active vehicle: a retried or redone
  -- onboarding replaces the vehicle it registered before.
  IF v_status IS NULL OR v_status IN ('pending_verification', 'under_review', 'rejected') THEN
    IF TG_OP = 'INSERT' AND NEW.is_active THEN
      PERFORM set_config('app.vehicles_internal', '1', true);
      UPDATE vehicles SET is_active = false
      WHERE driver_id = NEW.driver_id AND is_active AND id IS DISTINCT FROM NEW.id;
      PERFORM set_config('app.vehicles_internal', '', true);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Ya tienes un vehículo registrado. Para cambiarlo, edita el que tienes.',
      DETAIL = 'vehicle_add_after_approval';
  END IF;

  -- Only the type and the plate are reviewed; make, model, year, color,
  -- capacity, photo and cargo settings save as before. An inactive vehicle
  -- earns no rides (and a driver cannot activate one).
  IF NOT NEW.is_active
     OR (NEW.type IS NOT DISTINCT FROM OLD.type
         AND upper(regexp_replace(coalesce(NEW.plate_number, ''), '[^A-Za-z0-9]', '', 'g'))
           = upper(regexp_replace(coalesce(OLD.plate_number, ''), '[^A-Za-z0-9]', '', 'g'))) THEN
    RETURN NEW;
  END IF;

  IF v_status <> 'approved' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Tu cuenta está suspendida: para cambiar el tipo o la placa del vehículo, escribe a soporte.',
      DETAIL = 'vehicle_change_while_suspended';
  END IF;

  IF EXISTS (
    SELECT 1 FROM rides r
    WHERE r.driver_id = NEW.driver_id
      AND r.status::text IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Termina el viaje en curso antes de cambiar el tipo o la placa del vehículo.',
      DETAIL = 'vehicle_change_during_ride';
  END IF;

  -- Back to review: tg_driver_profiles_protect_admin_fields lets this one
  -- UPDATE through (it reverts a driver's own status change otherwise).
  PERFORM set_config('app.vehicle_rereview', NEW.driver_id::text, true);
  UPDATE driver_profiles SET status = 'under_review', is_online = false
  WHERE id = NEW.driver_id;
  PERFORM set_config('app.vehicle_rereview', '', true);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_vehicles_client_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_vehicles_client_guard
  BEFORE INSERT OR UPDATE ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION public.tg_vehicles_client_guard();

-- 4. A selfie check a driver opens starts without a result ------------------------
CREATE OR REPLACE FUNCTION public.tg_selfie_checks_protect_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- 00650: only verify-selfie (service role) or an admin records a result.
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    NEW.status           := 'pending';
    NEW.face_match_score := NULL;
    NEW.liveness_passed  := NULL;
    NEW.completed_at     := NULL;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_selfie_checks_protect_insert() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_selfie_checks_protect_insert
  BEFORE INSERT ON public.selfie_checks
  FOR EACH ROW EXECUTE FUNCTION public.tg_selfie_checks_protect_insert();

-- 5. Grants --------------------------------------------------------------------
REVOKE TRUNCATE, TRIGGER ON public.vehicles, public.driver_profiles, public.driver_documents,
  public.selfie_checks, public.driver_contracts FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.vehicles, public.driver_profiles, public.driver_documents,
  public.selfie_checks, public.driver_contracts FROM anon;
REVOKE DELETE ON public.vehicles, public.driver_profiles, public.driver_documents,
  public.selfie_checks FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.driver_contracts FROM authenticated;

-- 6. Pasted from Windows (CRLF), the new bodies would carry \r: recreate them from
--    the catalog without them so their md5 matches git.
DO $fix$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.tg_driver_documents_protect_review()',
    'public.tg_vehicles_client_guard()',
    'public.tg_selfie_checks_protect_insert()'
  ]::regprocedure[] LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$fix$;

-- 7. Check the result -------------------------------------------------------------
DO $check$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(f.fn || ' ' || coalesce(md5(p.prosrc), 'missing'), ', ') INTO v_bad
  FROM (VALUES
    ('public.tg_driver_profiles_protect_admin_fields()', 'ccded3e1847c164327dd049c9391ffde'),
    ('public.find_best_drivers(double precision,double precision,text,integer,integer,boolean,integer,text,numeric,integer,integer,integer,uuid)', 'ec914394abd6f03eeedffc1ae51e8db0'),
    ('public.notify_offline_drivers_for_searching_rides()', '2a317ff22745d2bbf80c86b20b426a17'),
    ('public.tg_driver_documents_protect_review()', '1fa394a57d0c9f63ae4f80c77e443f82'),
    ('public.tg_vehicles_client_guard()', 'e73b942bf8f3cebb15de8cd8d2b46ae2'),
    ('public.tg_selfie_checks_protect_insert()', '5360caa8539a974900342ddebf5a1698')
  ) AS f(fn, want)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.fn)
  WHERE md5(p.prosrc) IS DISTINCT FROM f.want;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00650: bodies are not the ones of git: %', v_bad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.vehicles'::regclass
                 AND tgname = 'trg_vehicles_client_guard' AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.selfie_checks'::regclass
                 AND tgname = 'trg_selfie_checks_protect_insert' AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.driver_documents'::regclass
                 AND tgname = 'trg_driver_documents_protect_review' AND tgenabled = 'O') THEN
    RAISE EXCEPTION '00650: a guard trigger is missing or disabled';
  END IF;

  SELECT string_agg(t || ':' || r || ':' || p, ', ') INTO v_bad
  FROM unnest(ARRAY['public.vehicles', 'public.driver_profiles', 'public.driver_documents',
                    'public.selfie_checks', 'public.driver_contracts']) t,
       unnest(ARRAY['anon', 'authenticated']) r,
       unnest(ARRAY['TRUNCATE', 'TRIGGER', 'DELETE']) p
  WHERE has_table_privilege(r, t, p);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00650: clients still hold %', v_bad;
  END IF;
  IF has_table_privilege('anon', 'public.vehicles', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.driver_contracts', 'INSERT') THEN
    RAISE EXCEPTION '00650: client writes left on vehicles/driver_contracts';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.vehicles', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.vehicles', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.driver_documents', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.selfie_checks', 'INSERT') THEN
    RAISE EXCEPTION '00650: drivers lost a write the app needs';
  END IF;
END
$check$;

RESET lock_timeout;
