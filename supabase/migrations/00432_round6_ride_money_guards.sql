-- 00432_round6_ride_money_guards.sql
-- ============================================================================
-- Pre-launch audit round 6 — two confirmed P2 ride-money correctness gaps.
-- Both are DB-only (no app rebuild) and protect money at launch.
--
-- RLC-01: update_ride_status_v2 is a SECOND, unguarded path to a terminal
-- ride status. complete_ride_and_pay is the ONLY RPC that moves money on
-- completion (it is well-protected: FOR UPDATE on the ride, status guard, and a
-- UNIQUE ledger idempotency_key — double-pay is impossible). But
-- update_ride_status_v2's ELSE branch does a bare `UPDATE rides SET status =
-- p_new_status::ride_status` with NO allow-list of target statuses, relying
-- entirely on the enforce_ride_transition FSM trigger — and valid_transitions
-- permits in_progress/arrived_at_destination -> completed for role 'driver'. The
-- RPC's authz only checks the caller is the assigned driver. So the assigned
-- driver could POST update_ride_status_v2 with p_new_status='completed' and flip
-- an active ride to 'completed' WITHOUT invoking complete_ride_and_pay: the ride
-- ends with final_fare NULL, no 'final' pricing snapshot, and NO ledger/payment.
-- For a CASH ride the platform commission (debited only in complete_ride_and_pay)
-- is never collected and the driver keeps 100% of the off-platform cash; the ride
-- is then unpayable (complete_ride_and_pay rejects status='completed'),
-- permanently corrupting state. Latent today (client guards 'completed', and prod
-- has only demo fixtures), but the RPC has EXECUTE to authenticated and the JS
-- client is untyped, so a modified driver client reaches it. Fix: reject terminal
-- transitions in the RPC itself (the FSM cannot tell complete_ride_and_pay's
-- UPDATE from a raw one, so the guard must live here). Applied as an in-place
-- patch of the live body so no other logic can be lost.
--
-- DSP-01: the wait charge billed to the rider is computed purely from two
-- driver-controlled timestamps (driver_arrived_at, pickup_at) with NO upper cap
-- and NO cross-check against ride_location_events. complete_ride_and_pay adds it
-- ON TOP of the immutable strict-parity fare snapshot, so it bypasses the pricing
-- contract. A driver who spoofs GPS to ~pickup can mark 'arrived' early, stall,
-- then mark 'in_progress', billing the rider for unbounded fabricated wait
-- minutes (auto_confort 80 CUP/min, etc.) that flow (net commission) to the
-- driver's tricicoin earnings. Fix (pragmatic, robust): cap billable wait minutes
-- at a configurable platform_config max (default 20). The deeper corroboration
-- against recorded positions is deferred. NOTE: only the BILLABLE minutes are
-- capped; wait_time_minutes still records the actual observed wait.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- RLC-01: in-place guard so update_ride_status_v2 never sets a terminal status.
-- ─────────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_src text;
  v_anchor text := $q$BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;$q$;
  v_repl text := $q$BEGIN
  -- RLC-01 (audit round 6): reject terminal / payment-bearing transitions.
  -- complete_ride_and_pay is the ONLY path allowed to set 'completed' (it moves
  -- money + writes the final snapshot); cancel_ride owns 'canceled'/'disputed'.
  -- The FSM trigger allows in_progress->completed for role 'driver' and cannot
  -- distinguish complete_ride_and_pay's UPDATE from a raw one, so the guard must
  -- live in this RPC.
  IF p_new_status IN ('completed', 'canceled', 'disputed') THEN
    RAISE EXCEPTION 'use complete_ride_and_pay / cancel_ride for terminal transitions';
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;$q$;
BEGIN
  SELECT pg_get_functiondef(
    'public.update_ride_status_v2(uuid,text,double precision,double precision,boolean)'::regprocedure
  ) INTO v_src;

  IF v_src IS NULL THEN
    RAISE NOTICE 'update_ride_status_v2 absent; skipping';
  ELSIF position('terminal transitions' IN v_src) > 0 THEN
    RAISE NOTICE 'update_ride_status_v2 already guarded; skipping';
  ELSIF position(v_anchor IN v_src) > 0 THEN
    EXECUTE replace(v_src, v_anchor, v_repl);
    RAISE NOTICE 'update_ride_status_v2: added terminal-status guard';
  ELSE
    RAISE NOTICE 'update_ride_status_v2: anchor not found; manual review required';
  END IF;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'update_ride_status_v2 absent; skipping';
END $patch$;

-- ─────────────────────────────────────────────────────────────────────────
-- DSP-01: cap billable wait minutes at a configurable platform_config max.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO platform_config (key, value)
VALUES ('max_billable_wait_minutes', '20')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.calculate_wait_charge(p_ride_id uuid)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride rides%ROWTYPE;
  v_svc service_type_configs%ROWTYPE;
  v_wait_seconds NUMERIC;
  v_wait_minutes INTEGER;
  v_billable_minutes INTEGER;
  v_max_billable INTEGER;
  v_charge INTEGER;
  result RECORD;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  SELECT * INTO v_svc FROM service_type_configs WHERE slug = v_ride.service_type;

  IF v_ride.driver_arrived_at IS NOT NULL AND v_ride.pickup_at IS NOT NULL THEN
    v_wait_seconds := EXTRACT(EPOCH FROM (v_ride.pickup_at::timestamptz - v_ride.driver_arrived_at::timestamptz));
    v_wait_minutes := GREATEST(0, FLOOR(v_wait_seconds / 60)::INTEGER);
    v_billable_minutes := GREATEST(0, v_wait_minutes - COALESCE(v_svc.free_wait_minutes, 5));
    -- DSP-01: clamp the BILLABLE minutes (driver-controlled timestamps are
    -- otherwise uncapped and bypass the strict-parity fare contract).
    v_max_billable := GREATEST(0, get_platform_config_numeric('max_billable_wait_minutes', 20)::INTEGER);
    v_billable_minutes := LEAST(v_billable_minutes, v_max_billable);
    v_charge := v_billable_minutes * COALESCE(v_svc.per_wait_minute_rate_cup, 0);
  ELSE
    v_wait_minutes := 0; v_billable_minutes := 0; v_charge := 0;
  END IF;

  -- wait_time_minutes records the ACTUAL observed wait; the charge reflects the
  -- capped billable minutes.
  UPDATE rides SET wait_time_minutes = v_wait_minutes, wait_time_charge_cup = v_charge WHERE id = p_ride_id;

  SELECT v_wait_minutes AS wait_minutes, v_billable_minutes AS billable_minutes, v_charge AS charge INTO result;
  RETURN result;
END;
$function$;
