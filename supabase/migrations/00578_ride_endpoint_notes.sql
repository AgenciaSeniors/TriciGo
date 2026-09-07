-- 00578_ride_endpoint_notes.sql
--
-- Rider notes for the driver, one per endpoint ("#302 apto 4, edificio
-- azul, tocar el timbre"). Until now the passenger app had NO field for
-- number / apartment / landmark / instructions: the Cuban address structure
-- lived only inside the geocoder's output string and the driver had to
-- call. Delivery rides had `delivery_details.special_instructions`;
-- passenger rides had nothing.
--
-- WHAT THIS ADDS
--   rides.pickup_notes  text  (<= 200 chars)   shown to the driver while
--   rides.dropoff_notes text  (<= 200 chars)   heading to that endpoint
--
-- WHERE THEY MUST NOT GO (deliberate, enforced by NOT touching the code)
--   * notify_driver_new_offer (00356) — the pre-accept push goes to EVERY
--     candidate driver; an apartment number is not for someone who never
--     takes the ride. The offer card in the driver app does not render them
--     either; the active-trip screen does.
--   * get_shared_ride_by_token / SharedRideView — public link for trusted
--     contacts. The service builds that view field by field; a unit test
--     asserts the notes never appear.
--
-- WHO MAY WRITE THEM
--   The customer, on insert (r_insert policy, 00001:585 — no RPC involved)
--   and through their own UPDATE path. The DRIVER may not: this migration
--   extends the driver deny-branch of enforce_ride_update_columns (00290)
--   with the two columns, patched in place from the LIVE function body so no
--   later feature of that trigger can be lost by re-transcription
--   (CLAUDE.md, "Patch in-place").
--
-- CLIENT TOLERANCE
--   The apps ship before this is applied (MCP guard). rideService.createRide
--   retries the insert WITHOUT the two keys on PostgREST's PGRST204 for
--   exactly these columns, so a ride still gets created — just without the
--   note — until the migration lands.
--
-- Idempotent: safe to re-run.
-- ============================================================

ALTER TABLE public.rides
  ADD COLUMN IF NOT EXISTS pickup_notes  text,
  ADD COLUMN IF NOT EXISTS dropoff_notes text;

COMMENT ON COLUMN public.rides.pickup_notes IS
  '00578: rider note for the driver at the pickup (apto, edificio, timbre). Max 200 chars. Not in push payloads, not in the public share view.';
COMMENT ON COLUMN public.rides.dropoff_notes IS
  '00578: rider note for the driver at the dropoff. Max 200 chars. Not in push payloads, not in the public share view.';

-- CHECK constraints, added only if absent (NULL passes a CHECK by SQL
-- semantics, which is what we want: no note = NULL).
DO $chk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.rides'::regclass AND conname = 'rides_pickup_notes_len'
  ) THEN
    ALTER TABLE public.rides
      ADD CONSTRAINT rides_pickup_notes_len
      CHECK (pickup_notes IS NULL OR char_length(pickup_notes) <= 200);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.rides'::regclass AND conname = 'rides_dropoff_notes_len'
  ) THEN
    ALTER TABLE public.rides
      ADD CONSTRAINT rides_dropoff_notes_len
      CHECK (dropoff_notes IS NULL OR char_length(dropoff_notes) <= 200);
  END IF;
END $chk$;

-- ── Driver may not rewrite the notes ──────────────────────────────────
-- enforce_ride_update_columns (live body = 00290; verified no later
-- migration redefines it) already blocks a driver from touching
-- pickup/dropoff addresses. Extend that same condition with the notes.
-- Patched in place from pg_get_functiondef so the rest of the trigger body
-- (whatever version is live) is preserved byte for byte.
DO $patch$
DECLARE
  v_src    text;
  v_n      int;
  c_target CONSTANT text := 'OR NEW.dropoff_address IS DISTINCT FROM OLD.dropoff_address THEN';
  c_repl   CONSTANT text := 'OR NEW.dropoff_address IS DISTINCT FROM OLD.dropoff_address
       OR NEW.pickup_notes IS DISTINCT FROM OLD.pickup_notes
       OR NEW.dropoff_notes IS DISTINCT FROM OLD.dropoff_notes THEN';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'enforce_ride_update_columns';

  IF v_src IS NULL THEN
    RAISE NOTICE '00578: enforce_ride_update_columns absent; skipping the driver guard';
    RETURN;
  END IF;

  -- Idempotence: already mentions the new columns → this patch ran.
  IF position('NEW.pickup_notes' IN v_src) > 0 THEN
    RAISE NOTICE '00578: enforce_ride_update_columns already guards the notes; skip';
    RETURN;
  END IF;

  v_n := (length(v_src) - length(replace(v_src, c_target, ''))) / length(c_target);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '00578: target literal found % times in enforce_ride_update_columns (expected 1) — the body drifted, patch by hand', v_n;
  END IF;

  EXECUTE replace(v_src, c_target, c_repl);
  RAISE NOTICE '00578: enforce_ride_update_columns now denies driver edits to pickup_notes/dropoff_notes';
END $patch$;
