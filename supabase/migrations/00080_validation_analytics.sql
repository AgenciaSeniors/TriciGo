-- Auto-accept rate by profit level
CREATE OR REPLACE FUNCTION public.get_auto_accept_rate(p_days_back int DEFAULT 7)
RETURNS TABLE(profit_level text, total bigint, accepted bigint, rejected bigint, accept_rate numeric)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    properties->>'profit_level' as profit_level,
    COUNT(*)::bigint as total,
    COUNT(*) FILTER (WHERE event_type = 'driver_ride_auto_accepted')::bigint as accepted,
    COUNT(*) FILTER (WHERE event_type = 'driver_ride_rejected')::bigint as rejected,
    ROUND(
      COUNT(*) FILTER (WHERE event_type = 'driver_ride_auto_accepted')::numeric / NULLIF(COUNT(*), 0) * 100,
      1
    ) as accept_rate
  FROM public.validation_events
  WHERE event_type IN ('driver_ride_auto_accepted', 'driver_ride_rejected')
    AND created_at >= now() - (p_days_back || ' days')::interval
  GROUP BY properties->>'profit_level'
$$;

-- Auto-nav follow rate
CREATE OR REPLACE FUNCTION public.get_auto_nav_rate(p_days_back int DEFAULT 7)
RETURNS TABLE(total bigint, triggered bigint, cancelled bigint, follow_rate numeric)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    COUNT(*)::bigint as total,
    COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_triggered')::bigint as triggered,
    COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_cancelled')::bigint as cancelled,
    ROUND(
      COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_triggered')::numeric /
      NULLIF(COUNT(*) FILTER (WHERE event_type IN ('driver_auto_nav_triggered', 'driver_auto_nav_cancelled')), 0) * 100,
      1
    ) as follow_rate
  FROM public.validation_events
  WHERE event_type IN ('driver_auto_nav_triggered', 'driver_auto_nav_cancelled')
    AND created_at >= now() - (p_days_back || ' days')::interval
$$;

-- Override frequency per driver
CREATE OR REPLACE FUNCTION public.get_override_frequency(p_days_back int DEFAULT 7, p_limit int DEFAULT 20)
RETURNS TABLE(driver_id uuid, total_overrides bigint, reject_count bigint, nav_cancel_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    driver_id,
    COUNT(*)::bigint as total_overrides,
    COUNT(*) FILTER (WHERE event_type = 'driver_ride_rejected')::bigint as reject_count,
    COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_cancelled')::bigint as nav_cancel_count
  FROM public.validation_events
  WHERE event_type IN ('driver_ride_rejected', 'driver_auto_nav_cancelled')
    AND created_at >= now() - (p_days_back || ' days')::interval
  GROUP BY driver_id
  ORDER BY total_overrides DESC
  LIMIT p_limit
$$;
