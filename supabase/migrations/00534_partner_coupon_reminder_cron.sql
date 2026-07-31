-- 00534_partner_coupon_reminder_cron.sql
-- One reminder push when ~30 minutes remain on an unredeemed coupon.
--
-- Two guards, both required and doing DIFFERENT jobs:
--   • the 25–35 min window against a 5-min cadence => caught AT LEAST once
--     (no coupon slips between ticks)
--   • reminded_at                                  => pushed AT MOST once
--     (a coupon caught by two consecutive ticks only fires on the first)
-- Removing either one breaks the guarantee it owns.

CREATE OR REPLACE FUNCTION public.notify_expiring_partner_coupons()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_row         RECORD;
  v_service_key TEXT;
  v_headers     JSONB;
  v_sent        INT := 0;
BEGIN
  v_service_key := public.get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_service_key');
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  FOR v_row IN
    SELECT pc.id, pc.user_id, pc.expires_at, pp.name AS place_name, pp.benefit_title
    FROM public.partner_coupons pc
    JOIN public.partner_places pp ON pp.id = pc.partner_place_id
    WHERE pc.redeemed_at IS NULL
      AND pc.reminded_at IS NULL
      AND pc.expires_at > now() + interval '25 minutes'
      AND pc.expires_at <= now() + interval '35 minutes'
  LOOP
    -- cron_http_post, never raw net.http_post: a cron calling an Edge
    -- Function through the raw call is BLIND to HTTP failures —
    -- cron.job_run_details reports success while the call 502s. That
    -- blindness is what froze the exchange rate for four days.
    PERFORM public.cron_http_post(
      'partner-coupon-reminder',
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body    := jsonb_build_object(
        'user_id',  v_row.user_id::text,
        'title',    'Te queda media hora',
        'body',     '¿Sigues en ' || v_row.place_name || '? Tu '
                    || lower(v_row.benefit_title) || ' vence a las '
                    || to_char(v_row.expires_at AT TIME ZONE 'America/Havana', 'HH24:MI') || '.',
        'category', 'partner_coupon',
        'data', jsonb_build_object(
          'type',      'partner_coupon',
          'coupon_id', v_row.id::text,
          'expires_at', v_row.expires_at
        )
      )
    );

    UPDATE public.partner_coupons SET reminded_at = now() WHERE id = v_row.id;
    v_sent := v_sent + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'sent', v_sent);
END;
$$;

REVOKE ALL ON FUNCTION public.notify_expiring_partner_coupons() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.notify_expiring_partner_coupons() IS
  '00534 One reminder push per unredeemed coupon with ~30 minutes left. The 25-35 min window against the 5-minute cadence gives at-least-once; reminded_at gives at-most-once. Cron-only: never granted to anon or authenticated.';

DO $$
BEGIN
  PERFORM cron.unschedule('partner-coupon-reminder');
EXCEPTION WHEN OTHERS THEN
  NULL;  -- not scheduled yet
END $$;

SELECT cron.schedule(
  'partner-coupon-reminder',
  '*/5 * * * *',
  $cron$ SELECT public.notify_expiring_partner_coupons(); $cron$
);
