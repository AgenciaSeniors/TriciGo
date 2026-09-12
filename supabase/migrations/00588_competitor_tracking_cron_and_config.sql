-- 00588 — Competitor price observatory: tunables + cron
--
-- Schedules track-competitor-prices via cron_http_post (the REGLA DURA: every
-- cron→EF call goes through cron_http_post, never net.http_post; Bearer + apikey
-- from get_service_role_key(), never a hardcoded JWT — cf. the 2026-08-17
-- UNAUTHORIZED_LEGACY_JWT incident).
--
-- The basket is quoted every 15 min per the owner's decision. To keep both
-- competitors inside cron_http_post's 30s ceiling, the cron fires the EF ONCE
-- PER COMPETITOR (two entries), each with its own full basket. The EF's
-- own-price calc is negligible; the wall-clock cost is the competitor API calls.
--
-- Cron minute offset: the :00/:15/:30/:45 slots are already taken by
-- sync-exchange-rate, sync-weather and drain-poi-import-queue. We use :07 (la_nave)
-- and :09 (cinco) past each quarter hour to avoid the thundering herd; the two are
-- staggered so they don't contend either.

-- ── Tunables ────────────────────────────────────────────────────────────────
INSERT INTO public.platform_config (key, value) VALUES
  ('competitor_tracking_enabled',        to_jsonb(true)),
  ('competitor_tracking_interval_min',   to_jsonb(15)),
  ('competitor_tracking_stale_hours',    to_jsonb(2)),
  ('competitor_session_warn_hours',      to_jsonb(24)),
  ('competitor_quotes_retention_days',   to_jsonb(365)),
  ('competitor_quotes_prune_batch',      to_jsonb(20000))
ON CONFLICT (key) DO NOTHING;

-- ── Cron: la_nave ───────────────────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'track-competitor-la-nave') THEN
    PERFORM cron.unschedule('track-competitor-la-nave');
  END IF;
END $$;

SELECT cron.schedule(
  'track-competitor-la-nave',
  '7,22,37,52 * * * *',
  $cron$
  SELECT public.cron_http_post('track-competitor-la-nave',
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/track-competitor-prices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_service_role_key(),
      'apikey', get_service_role_key()
    ),
    body := jsonb_build_object('competitor', 'la_nave')
  );
  $cron$
);

-- ── Cron: cinco ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'track-competitor-cinco') THEN
    PERFORM cron.unschedule('track-competitor-cinco');
  END IF;
END $$;

SELECT cron.schedule(
  'track-competitor-cinco',
  '9,24,39,54 * * * *',
  $cron$
  SELECT public.cron_http_post('track-competitor-cinco',
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/track-competitor-prices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_service_role_key(),
      'apikey', get_service_role_key()
    ),
    body := jsonb_build_object('competitor', 'cinco')
  );
  $cron$
);
