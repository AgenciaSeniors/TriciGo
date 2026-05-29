-- ============================================================
-- Migration 00346: get_gift_stats — global admin KPIs for gifts
--
-- The admin gifts panel (00343-00345 feature) computed KPIs from the
-- currently-loaded page only. This RPC returns GLOBAL stats so the
-- panel KPIs are accurate. Admin-gated (role check) + SECURITY DEFINER,
-- mirroring the gate in admin_adjust_wallet (00338).
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_gift_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_is_admin BOOLEAN;
  v_result jsonb;
BEGIN
  SELECT (role IN ('admin', 'super_admin')) INTO v_is_admin FROM users WHERE id = auth.uid();
  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  SELECT jsonb_build_object(
    'total_gifts',      COUNT(*) FILTER (WHERE kind = 'gift'),
    'reversed',         COUNT(*) FILTER (WHERE reversed_at IS NOT NULL),
    'volume_cup',       COALESCE(SUM(amount) FILTER (WHERE kind = 'gift' AND reversed_at IS NULL), 0),
    'gifts_7d',         COUNT(*) FILTER (WHERE kind = 'gift' AND created_at > now() - interval '7 days'),
    'distinct_senders', COUNT(DISTINCT from_user_id) FILTER (WHERE kind = 'gift' AND from_user_id IS NOT NULL)
  ) INTO v_result
  FROM wallet_transfers;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_gift_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gift_stats() TO authenticated;

COMMENT ON FUNCTION public.get_gift_stats() IS
  '00346: admin-only global gift KPIs (total, reversed, volume_cup, gifts_7d, distinct_senders) for the admin Regalos panel.';
