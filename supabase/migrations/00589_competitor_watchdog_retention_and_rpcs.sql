-- 00589 — Competitor price observatory: watchdog, retention, panel RPCs
--
-- Follows the mature watchdog pattern (00503/00577: transition-only alerts, state
-- in platform_config.*_health_*) and the batched-prune pattern (00576: a big
-- DELETE once tumbled the base — never again). SQL-pure, not an Edge Function:
-- detecting staleness via net.http_post would inherit pg_cron's blindness (the
-- lesson of the 4-month-silent FX scraper).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Watchdog — alerts by transition when tracking goes stale OR a session is
--    about to expire (so the owner can renew BEFORE quotes start failing).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.check_competitor_tracking_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_stale_h       numeric := COALESCE(get_platform_config_numeric('competitor_tracking_stale_hours', 2), 2);
  v_warn_h        numeric := COALESCE(get_platform_config_numeric('competitor_session_warn_hours', 24), 24);
  v_last          timestamptz;
  v_age_h         numeric;
  v_expiring      text;      -- CSV of competitors whose session expires soon
  v_status        text;
  v_prev          text;
  v_detail        text;
  v_now           timestamptz := now();
  v_service_key   text;
  v_headers       jsonb;
  v_to_raw        text;
  v_rcpt          text;
  v_subject       text;
  v_html          text;
  v_sent          int := 0;
BEGIN
  -- Freshness: newest captured_at across all quotes.
  SELECT max(captured_at) INTO v_last FROM competitor_quotes;
  IF v_last IS NULL THEN
    v_age_h := NULL;
  ELSE
    v_age_h := round(extract(epoch FROM (v_now - v_last)) / 3600.0, 1);
  END IF;

  -- Sessions expiring within the warn window.
  SELECT string_agg(competitor, ', ' ORDER BY competitor) INTO v_expiring
    FROM competitor_sessions
    WHERE expires_at IS NOT NULL AND expires_at <= v_now + make_interval(hours => v_warn_h::int);

  -- Status precedence: stale > credential_expiring > ok.
  IF v_last IS NULL OR v_age_h >= v_stale_h THEN
    v_status := 'stale';
  ELSIF v_expiring IS NOT NULL THEN
    v_status := 'credential_expiring';
  ELSE
    v_status := 'ok';
  END IF;

  v_detail := CASE
    WHEN v_status = 'stale' THEN 'sin cotizaciones hace ' || COALESCE(v_age_h::text || ' h', '(nunca)')
    WHEN v_status = 'credential_expiring' THEN 'sesión por vencer: ' || v_expiring
    ELSE 'última cotización hace ' || COALESCE(v_age_h::text, '—') || ' h' END;

  SELECT value #>> '{}' INTO v_prev FROM platform_config WHERE key = 'competitor_tracking_health_status';
  v_prev := COALESCE(v_prev, 'unknown');

  -- Persist state ALWAYS, before deciding to email.
  INSERT INTO platform_config (key, value) VALUES
    ('competitor_tracking_health_status', to_jsonb(v_status)),
    ('competitor_tracking_health_at',     to_jsonb(v_now::text)),
    ('competitor_tracking_health_detail', to_jsonb(v_detail))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  -- Alert only on transition (any change of status; recovery to ok included).
  IF v_prev IS DISTINCT FROM v_status THEN
    SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'business_notification_email';
    IF v_to_raw IS NOT NULL AND position('@' IN v_to_raw) > 0 THEN
      v_service_key := get_service_role_key();
      v_headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_key, 'apikey', v_service_key);

      IF v_status = 'ok' THEN
        v_subject := '[TriciGo] Rastreo de precios de competencia recuperado';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#059669;border-bottom:2px solid #059669;padding-bottom:8px">Rastreo recuperado</h2>'
          || '<p>El observatorio de precios volvió a capturar cotizaciones con normalidad.</p>'
          || '<p style="color:#777;font-size:12px">Watchdog automático. No responder.</p></body></html>';
      ELSE
        v_subject := CASE WHEN v_status = 'stale'
          THEN '[TriciGo] Rastreo de precios de competencia DETENIDO'
          ELSE '[TriciGo] Sesión de competencia por vencer' END;
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#d97706;border-bottom:2px solid #d97706;padding-bottom:8px">'
          || CASE WHEN v_status = 'stale' THEN 'Rastreo detenido' ELSE 'Sesión por vencer' END || '</h2>'
          || '<p>' || v_detail || '.</p>'
          || CASE WHEN v_status = 'credential_expiring'
             THEN '<p>Renová la sesión del competidor desde el celular (deposit-competitor-session) '
                  || 'antes de que venza, o las cotizaciones empezarán a fallar.</p>'
             ELSE '<p>Revisá los logs de la Edge Function <code>track-competitor-prices</code> y el '
                  || 'estado de <code>competitor_sessions</code> (¿credencial vencida?).</p>' END
          || '<p style="color:#777;font-size:12px">Watchdog automático. No responder.</p></body></html>';
      END IF;

      FOR v_rcpt IN
        SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x) WHERE position('@' IN x) > 0
      LOOP
        PERFORM net.http_post(
          url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
          headers := v_headers,
          body    := jsonb_build_object('recipient_email', v_rcpt, 'subject', v_subject, 'template', v_html, 'data', '{}'::jsonb));
        v_sent := v_sent + 1;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object('status', v_status, 'prev', v_prev, 'age_hours', v_age_h,
    'expiring', v_expiring, 'transitioned', (v_prev IS DISTINCT FROM v_status), 'emails_sent', v_sent);

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'check_competitor_tracking_health failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

COMMENT ON FUNCTION public.check_competitor_tracking_health() IS
  '00589: watchdog del observatorio de precios. Alerta por email en transición '
  '(stale / credential_expiring / ok). SQL puro: detectar vía net.http_post heredaría '
  'la ceguera de pg_cron.';

REVOKE ALL ON FUNCTION public.check_competitor_tracking_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_competitor_tracking_health() TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Retention — batched prune (a single big DELETE once tumbled the base).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.prune_competitor_quotes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  -- ::int obligatorio: get_platform_config_numeric devuelve NUMERIC y make_interval
  -- solo acepta INT en days (trampa de 00527, ver CLAUDE.md).
  v_keep_days int := COALESCE(get_platform_config_numeric('competitor_quotes_retention_days', 365), 365)::int;
  v_batch     int := COALESCE(get_platform_config_numeric('competitor_quotes_prune_batch', 20000), 20000)::int;
  v_deleted int := 0;
BEGIN
  DELETE FROM competitor_quotes WHERE ctid IN (
    SELECT q.ctid FROM competitor_quotes q
    WHERE q.captured_at < now() - make_interval(days => v_keep_days)
    LIMIT v_batch);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'deleted', v_deleted, 'retention_days', v_keep_days,
    'batch', v_batch, 'remaining_rows', (SELECT count(*) FROM competitor_quotes));
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'prune_competitor_quotes failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

COMMENT ON FUNCTION public.prune_competitor_quotes() IS
  '00589: poda por tandas de competitor_quotes (retención competitor_quotes_retention_days). '
  'Por tandas a propósito: un DELETE masivo genera un pico de WAL que ya tumbó la base (lección 00576).';

REVOKE ALL ON FUNCTION public.prune_competitor_quotes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_competitor_quotes() TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Panel RPCs (admin-gated). Keep aggregation in the DB rather than exposing
--    the table directly.
-- ═══════════════════════════════════════════════════════════════════════════

-- Summary: latest quote per (route, competitor, category) and the delta vs our price.
CREATE OR REPLACE FUNCTION public.get_competitor_summary()
RETURNS TABLE (
  route_id uuid, route_label text, province text,
  competitor text, competitor_category text, tricigo_service_type text,
  competitor_price_cup integer, tricigo_price_cup integer,
  delta_cup integer, cheaper_side text, captured_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT r.id, r.label, r.province,
         q.competitor, q.competitor_category, q.tricigo_service_type,
         q.competitor_price_cup, q.tricigo_price_cup,
         (q.competitor_price_cup - q.tricigo_price_cup) AS delta_cup,
         CASE
           WHEN q.competitor_price_cup IS NULL THEN 'unknown'
           WHEN q.tricigo_price_cup < q.competitor_price_cup THEN 'tricigo'
           WHEN q.tricigo_price_cup > q.competitor_price_cup THEN 'competitor'
           ELSE 'tie' END AS cheaper_side,
         q.captured_at
  FROM competitor_routes r
  JOIN LATERAL (
    SELECT DISTINCT ON (cq.competitor, cq.competitor_category)
      cq.competitor, cq.competitor_category, cq.tricigo_service_type,
      cq.competitor_price_cup, cq.tricigo_price_cup, cq.captured_at
    FROM competitor_quotes cq
    WHERE cq.route_id = r.id
    ORDER BY cq.competitor, cq.competitor_category, cq.captured_at DESC
  ) q ON true
  WHERE public.is_admin() AND r.is_active = true
  ORDER BY r.province, r.label, q.competitor, q.competitor_category;
$function$;

COMMENT ON FUNCTION public.get_competitor_summary() IS
  '00589: última cotización por (ruta, competidor, categoría) con el delta vs el precio de TriciGo. '
  'Admin-gated (is_admin() en el WHERE → vacío para no-admin).';

REVOKE ALL ON FUNCTION public.get_competitor_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_competitor_summary() TO authenticated, service_role;

-- Series: the time series for one route (both competitors + our price), N days back.
CREATE OR REPLACE FUNCTION public.get_competitor_price_series(p_route_id uuid, p_days_back integer DEFAULT 30)
RETURNS TABLE (
  captured_at timestamptz, competitor text, competitor_category text,
  competitor_price_cup integer, tricigo_price_cup integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT cq.captured_at, cq.competitor, cq.competitor_category,
         cq.competitor_price_cup, cq.tricigo_price_cup
  FROM competitor_quotes cq
  WHERE public.is_admin()
    AND cq.route_id = p_route_id
    AND cq.captured_at >= now() - make_interval(days => GREATEST(1, LEAST(p_days_back, 365)))
  ORDER BY cq.captured_at;
$function$;

COMMENT ON FUNCTION public.get_competitor_price_series(uuid, integer) IS
  '00589: serie temporal de precios (competidores + TriciGo) para una ruta, N días atrás (clamp 1..365). '
  'Admin-gated.';

REVOKE ALL ON FUNCTION public.get_competitor_price_series(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_competitor_price_series(uuid, integer) TO authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Crons — SQL-pure functions run directly (the cron_http_post rule applies to
--    EF calls, not SQL functions — cf. 00538 note). Free minutes: :48 / :43.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-competitor-tracking-health') THEN
    PERFORM cron.unschedule('check-competitor-tracking-health');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-competitor-quotes') THEN
    PERFORM cron.unschedule('prune-competitor-quotes');
  END IF;
END $$;

SELECT cron.schedule('check-competitor-tracking-health', '48 * * * *',
  $cron$ SELECT public.check_competitor_tracking_health(); $cron$);

SELECT cron.schedule('prune-competitor-quotes', '43 * * * *',
  $cron$ SELECT public.prune_competitor_quotes(); $cron$);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Anti-false-positive seed: record the real current status so applying this
--    migration does not fire a spurious "transition" email.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_status text;
BEGIN
  -- Compute the same status the watchdog would, without emailing.
  IF NOT EXISTS (SELECT 1 FROM competitor_quotes) THEN
    v_status := 'stale';  -- no data yet at apply time (expected on first deploy)
  ELSE
    v_status := 'ok';
  END IF;
  INSERT INTO platform_config (key, value) VALUES
    ('competitor_tracking_health_status', to_jsonb(v_status)),
    ('competitor_tracking_health_at',     to_jsonb(now()::text)),
    ('competitor_tracking_health_detail', to_jsonb('sembrado al aplicar 00589'::text))
  ON CONFLICT (key) DO NOTHING;
END $$;
