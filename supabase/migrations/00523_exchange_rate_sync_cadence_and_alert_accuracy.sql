-- 00523: survive elToque's 1-request-per-second limit, and make the alert tell the
-- truth about what it measured.
--
-- INCIDENT 2026-07-29. The USD/CUP rate froze for ~20 hours (last write 2026-07-28
-- 19:00 UTC). Recharges break at 24h, so this came within ~3h of blocking every
-- top-up. Measured against production, not inferred:
--
--   * tasas.eltoque.com rate-limits to ONE REQUEST PER SECOND PER SOURCE IP. Five
--     simultaneous probes all returned HTTP 429 with Flask-Limiter's page
--     (<title>429 Too Many Requests</title> ... <p>1 per 1 second</p>); the same call
--     on its own returned 200 with USD 675.
--   * eltoque.com (the scraper fallback) has answered 403 "Just a moment..." — a
--     Cloudflare managed challenge — since 2026-07-28 05:00. It is NOT a fallback any
--     more. Until then it had been quietly carrying the whole feed: 24/24 successful
--     writes on 07-27 came from scraping, because the API had already decayed from
--     24/24 (07-21) to 0/24 (07-27).
--   * The failures are fast rejections, not timeouts: failed runs took ~3.9s and
--     successful ones ~1.5s (Edge execution_time_ms). Timeouts would be 30s+.
--
-- So the feed had silently degraded to a SINGLE source that rejects us whenever the
-- shared Supabase Edge egress IP is busy — and we sampled it once an hour, which means
-- one unlucky moment cost a whole hour of the 24h freshness budget. Twenty in a row
-- emptied it.
--
-- Two changes here; the Edge Function change (spacing attempts above the rate limit and
-- reporting per-attempt HTTP status in the response body) ships alongside.

-- ---------------------------------------------------------------------------
-- 1. Sample every 15 minutes instead of hourly.
-- ---------------------------------------------------------------------------
-- This is the high-leverage half. Retrying harder inside one run cannot help: our own
-- traffic (<=3 requests/hour) cannot exhaust a per-second budget, so a rejection comes
-- from traffic we do not control, and attempts seconds apart are correlated with each
-- other. Attempts 15 minutes apart are not. Four samples an hour turns "no data at all
-- this hour" into "data 15 minutes later".
--
-- Verified safe before quadrupling it: the only trigger on exchange_rates is
-- trg_exchange_rate_recompute_prices -> recompute_cup_from_usd_prices(), which is
-- idempotent when the rate is unchanged. Wallet revaluation does NOT ride on rate
-- writes — revalue_anchored_wallets has its own daily cron ('30 4 * * *'), so this
-- does not touch money. Cost is table growth: 96 rows/day instead of 24.
DO $$
DECLARE
  v_jobid    bigint;
  v_schedule text;
BEGIN
  SELECT jobid, schedule INTO v_jobid, v_schedule
  FROM cron.job WHERE jobname = 'sync-exchange-rate';

  IF v_jobid IS NULL THEN
    RAISE NOTICE '00523: cron job sync-exchange-rate not found; nothing to reschedule';
  ELSIF v_schedule = '*/15 * * * *' THEN
    RAISE NOTICE '00523: sync-exchange-rate already runs every 15 minutes; no change';
  ELSE
    PERFORM cron.alter_job(v_jobid, schedule => '*/15 * * * *');
    RAISE NOTICE '00523: sync-exchange-rate rescheduled from % to */15 * * * *', v_schedule;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Fix two things the alert email got wrong, both of which cost real time today.
-- ---------------------------------------------------------------------------
-- Patched in place from the LIVE body rather than rewritten verbatim: the function is
-- large and a hand-retyped copy is how 00124 silently dropped features. Each patch is
-- guarded on its own marker, so re-running this migration is a no-op.

-- 2a. The row labelled "Fecha (UTC)" printed v_now — the moment the WATCHDOG ran, not
--     the moment the rate was fetched. The email therefore read "20.3 h de antigüedad"
--     next to a timestamp from five minutes ago, which reads as self-contradictory
--     exactly when someone is trying to judge how urgent the page is. v_fetched is
--     right there in the same DECLARE block.
DO $patch$
DECLARE
  v_src text;
  v_old text := $old$<b>Fecha (UTC)</b></td><td style="padding:6px;text-align:right">' || v_now::text$old$;
  v_new text := $new$<b>Tasa obtenida (UTC)</b></td><td style="padding:6px;text-align:right">' || COALESCE(v_fetched::text, 'sin fila is_current')$new$;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef('public.check_exchange_rate_freshness()'::regprocedure) INTO v_src;

  IF position('Tasa obtenida (UTC)' IN v_src) > 0 THEN
    RAISE NOTICE '00523: alert date label already corrected; skipping';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_old, ''))) / NULLIF(length(v_old), 0);
  IF v_hits <> 1 THEN
    RAISE WARNING '00523: expected exactly 1 occurrence of the date row, found % — leaving alert body untouched', v_hits;
    RETURN;
  END IF;

  EXECUTE replace(v_src, v_old, v_new);
  RAISE NOTICE '00523: alert now reports the rate timestamp instead of the watchdog run time';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00523: check_exchange_rate_freshness() absent; skipping alert patch';
END $patch$;

-- 2b. "Qué revisar" sent the operator to the Edge Function logs. Those are NOT reachable
--     from SQL or the Supabase MCP, so following that instruction today dead-ended and
--     the cause had to be cornered by black-box probing instead. The reason now travels
--     in the response body, which pg_net already persists — point at that.
--
--     NOTE the doubled quotes in ''sync-exchange-rate'' below. Unlike patch 2a, whose
--     target ends with "|| v_now::text" and therefore lands in EXPRESSION context, this
--     target sits entirely INSIDE the v_html string literal, so every apostrophe in the
--     replacement must be escaped or it terminates that literal. The first attempt at
--     this migration spliced in a bare 'sync-exchange-rate' and CREATE OR REPLACE died
--     with: syntax error at or near "-" (Postgres reading the hyphens as subtraction).
--     Harmless -- the whole migration is one transaction and nothing was applied -- but
--     worth naming: when splicing text into a plpgsql body, first work out which
--     context the splice point lands in.
DO $patch$
DECLARE
  v_src text;
  v_old text := $old$<p><b>Qué revisar:</b> los logs de la Edge Function <code>sync-exchange-rate</code>. $old$;
  v_new text := $new$<p><b>Qué revisar:</b> el cuerpo de la última respuesta del cron (los logs de la Edge Function no son accesibles desde SQL): <code>SELECT r.status_code, r.content FROM cron_http_calls c JOIN net._http_response r ON r.id = c.request_id WHERE c.jobname = ''sync-exchange-rate'' ORDER BY c.called_at DESC LIMIT 5;</code> — trae <code>api_attempts</code> con el código HTTP de cada intento: <b>429</b> = tope de 1 petición/segundo de elTOQUE (se recupera solo en la siguiente corrida), <b>403</b> = desafío de Cloudflare, <b>config_*</b> = configuración nuestra. $new$;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef('public.check_exchange_rate_freshness()'::regprocedure) INTO v_src;

  IF position('no son accesibles desde SQL' IN v_src) > 0 THEN
    RAISE NOTICE '00523: alert triage text already corrected; skipping';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_old, ''))) / NULLIF(length(v_old), 0);
  IF v_hits <> 1 THEN
    RAISE WARNING '00523: expected exactly 1 occurrence of the triage sentence, found % — leaving alert body untouched', v_hits;
    RETURN;
  END IF;

  EXECUTE replace(v_src, v_old, v_new);
  RAISE NOTICE '00523: alert triage text now points at cron_http_calls instead of unreachable Edge logs';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00523: check_exchange_rate_freshness() absent; skipping alert patch';
END $patch$;
