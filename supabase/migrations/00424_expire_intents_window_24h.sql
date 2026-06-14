-- 00424_expire_intents_window_24h.sql
-- ============================================================================
-- CRON-01 (P1, audit 2026-06-14): the 'expire-stale-payment-intents' cron flips
-- created|pending → 'expired' after only 1 HOUR. A legitimately PAID NETOPIA IPN
-- can arrive later (3DS challenge, hosted-page abandon-then-complete, delayed
-- settlement, the documented interim-then-final two-IPN pattern). The PRIMARY fix
-- is in process-netopia-webhook (its atomic claim now recovers 'expired'), so a
-- late paid IPN credits correctly regardless of the cron. This migration is
-- defense-in-depth: widen the expiry window to 24h (well beyond NETOPIA's
-- settlement window) so intents are rarely 'expired' before their final IPN, and
-- update the error message text to match.
--
-- Idempotent: only rewrites the command if it still says '1 hour'. Robust:
-- patches the live command string in place so any other detail is preserved.
-- ============================================================================

DO $$
DECLARE
  v_jobid bigint;
  v_cmd   text;
BEGIN
  SELECT jobid, command INTO v_jobid, v_cmd
  FROM cron.job WHERE jobname = 'expire-stale-payment-intents';

  IF v_jobid IS NULL THEN
    RAISE NOTICE 'expire-stale-payment-intents cron not found; skipping';
  ELSIF v_cmd LIKE '%INTERVAL ''1 hour''%' THEN
    v_cmd := replace(v_cmd, 'INTERVAL ''1 hour''', 'INTERVAL ''24 hours''');
    v_cmd := replace(v_cmd, 'within 1h', 'within 24h');
    PERFORM cron.alter_job(job_id := v_jobid, command := v_cmd);
    RAISE NOTICE 'expire-stale-payment-intents: expiry window 1h -> 24h';
  ELSE
    RAISE NOTICE 'expire-stale-payment-intents: already widened (no 1 hour interval); skipping';
  END IF;
END $$;
