-- 00537_online_vehicle_guard_above_admin_bypass.sql
--
-- Move the "going online requires an active vehicle" guard ABOVE the
-- `is_admin()` early return in tg_driver_profiles_protect_admin_fields.
--
-- Why
-- ---
-- 00495 added two guards. The APPROVAL guard was deliberately placed above the
-- is_admin()/service-role bypasses so it gates the admin approveDriver UPDATE
-- and the auto-admin edge function alike. The ONLINE guard was not: it sits
-- below both early returns, so a user who is BOTH admin and driver could go
-- online with no active vehicle. Verified against the live function body:
--
--   approval guard              @ 606
--   IF is_admin() THEN          @ 719   <- bypass
--   auth.uid() IS NULL          @ 770   <- bypass (service role)
--   driver_not_approved_for_online @ 1001
--   online vehicle guard        @ 1570  <- BELOW both bypasses
--
-- Until now the client-side pre-check in driverService.setOnlineStatus was the
-- only gate for that case — and it was just changed to FAIL OPEN when its query
-- errors (so a transient failure no longer misfires as "register your vehicle").
-- That makes closing the trigger-side hole the right move.
--
-- There are 0 admin+driver users in prod today, so this is latent, not live.
-- It comes back the moment the QA pattern from CLAUDE.md ("Eduardo Admin =
-- super_admin + driver") is recreated.
--
-- Safety (verified against prod, not assumed)
-- -------------------------------------------
-- Moving the guard also places it above the service-role bypass. Only two
-- server-side functions touch driver_profiles.is_online:
--   * auto_offline_stale_drivers  — sets is_online = FALSE. The guard only
--     fires on a transition TO true, so it is unaffected.
--   * driver_heartbeat (auto-restore) — sets is_online = true, but already
--     filters on `EXISTS (SELECT 1 FROM vehicles ... is_active = true)`
--     precisely to satisfy this trigger. Unaffected.
-- The admin app never writes is_online (it only reads it for filters/counts).
--
-- Method
-- ------
-- In-place patch of the LIVE body (CLAUDE.md: "Patch in-place para cambios de
-- UNA línea en RPCs grandes"). The block is EXTRACTED AT RUNTIME from
-- pg_get_functiondef rather than transcribed here, so this cannot drift from
-- prod on whitespace or the em-dash in the comment, and — unlike a verbatim
-- rewrite — it cannot silently drop a feature the way 00124 did.
-- Idempotent: re-running is a no-op.
--
-- NOTE on the anchor: the live body says `-- 00491 (online gate)`, not 00495.
-- The file that created it was renumbered 00491 -> 00495 (00491 had collided
-- with 00491_campaigns_promo_code_on_delete_set_null.sql) but the comments
-- INSIDE the SQL body kept the old number. Anchoring on "00495" matches
-- nothing — verified by a dry run that silently changed nothing.

DO $patch$
DECLARE
  v_src        text;
  v_block      text;
  v_start      int;
  v_raise      int;
  v_endif_rel  int;
  v_block_end  int;
  v_pos_admin  int;
  v_len_before int;
BEGIN
  SELECT pg_get_functiondef('public.tg_driver_profiles_protect_admin_fields()'::regprocedure)
    INTO v_src;

  IF v_src IS NULL THEN
    RAISE NOTICE '[00537] function absent; skipping';
    RETURN;
  END IF;

  v_len_before := length(v_src);
  v_start      := position('  -- 00491 (online gate)' IN v_src);
  v_raise      := position('driver_has_no_active_vehicle_for_online' IN v_src);
  v_pos_admin  := position('  IF is_admin() THEN' IN v_src);

  -- Idempotency: already relocated (or shape unrecognised) → do nothing.
  IF v_start = 0 OR v_raise = 0 OR v_pos_admin = 0 THEN
    RAISE NOTICE '[00537] anchors not found; leaving function untouched';
    RETURN;
  END IF;
  IF v_raise < v_pos_admin THEN
    RAISE NOTICE '[00537] guard already above the is_admin() bypass; skipping';
    RETURN;
  END IF;

  -- Anchors must be unambiguous before we cut anything.
  IF (length(v_src) - length(replace(v_src, '  IF is_admin() THEN', '')))
       / length('  IF is_admin() THEN') <> 1
     OR (length(v_src) - length(replace(v_src, 'driver_has_no_active_vehicle_for_online', '')))
       / length('driver_has_no_active_vehicle_for_online') <> 1
     OR (length(v_src) - length(replace(v_src, '  -- 00491 (online gate)', '')))
       / length('  -- 00491 (online gate)') <> 1 THEN
    RAISE EXCEPTION '[00537] anchors are not unique; refusing to patch';
  END IF;

  -- The guard block runs from its comment through the first END IF; after the
  -- RAISE. Extracted from the live source — never retyped.
  v_endif_rel := position('END IF;' IN substring(v_src FROM v_raise));
  IF v_endif_rel = 0 THEN
    RAISE EXCEPTION '[00537] could not find the END IF; closing the online guard';
  END IF;
  v_block_end := v_raise + v_endif_rel - 1 + length('END IF;');
  v_block     := substring(v_src FROM v_start FOR v_block_end - v_start);

  IF v_block !~ 'is_online' OR v_block !~ 'RAISE EXCEPTION' THEN
    RAISE EXCEPTION '[00537] extracted block does not look like the guard: %', left(v_block, 120);
  END IF;

  -- Cut it out, then re-insert immediately before the is_admin() bypass — the
  -- same position (and for the same reason) as the approval guard above it.
  v_src := replace(v_src, v_block, '');
  v_src := replace(
    v_src,
    '  IF is_admin() THEN',
    v_block || E'\n\n  IF is_admin() THEN'
  );

  -- The block moved, so total length must be preserved up to the two newlines
  -- we inserted. A larger drift means something else was replaced too.
  IF length(v_src) <> v_len_before + 2 THEN
    RAISE EXCEPTION '[00537] unexpected length drift: % -> % (expected %)',
      v_len_before, length(v_src), v_len_before + 2;
  END IF;

  EXECUTE v_src;
  RAISE NOTICE '[00537] online vehicle guard relocated above the is_admin() bypass';
END $patch$;

COMMENT ON FUNCTION public.tg_driver_profiles_protect_admin_fields() IS
  '00537: the online-vehicle guard now sits above the is_admin()/service-role bypasses, matching the approval guard from 00495. Both gate every caller.';
