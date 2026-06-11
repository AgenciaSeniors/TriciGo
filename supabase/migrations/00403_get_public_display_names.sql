-- ============================================================
-- 00403 — get_public_display_names(p_user_ids uuid[])
--
-- PASS2 P1 (fare split): ride_splits.user_id FKs to auth.users (not
-- exposed to PostgREST) and public.users has no raw_user_meta_data
-- column, so the old `users:user_id(raw_user_meta_data)` embed in
-- getSplitsForRide 400'd with PGRST200 on every call — the split
-- participant list was empty forever on web AND mobile.
--
-- RLS on public.users (users_select_own, mig 00291) only lets a user
-- read their own row, so the client cannot name other participants with
-- a direct select either. This SECURITY DEFINER lookup returns the
-- MINIMAL public display fields (name + avatar — no phone, no email)
-- for explicit UUIDs the caller already knows. UUIDs are not
-- enumerable, the array is capped at 50, and only active users are
-- returned. Same disclosure level as find_user_by_phone (00344), which
-- already returns full_name to any authenticated caller.
--
-- Consumers: rideService.getSplitsForRide (fare split participants,
-- web + client) and the web /driver-profile header (PASS2 PR-I).
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_public_display_names(p_user_ids uuid[])
RETURNS TABLE (user_id uuid, full_name text, avatar_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT u.id, u.full_name, u.avatar_url
  FROM public.users u
  WHERE u.id = ANY (p_user_ids[1:50])
    AND u.is_active = true;
$$;

COMMENT ON FUNCTION public.get_public_display_names(uuid[]) IS
  '00403: minimal public display lookup (name+avatar) for known UUIDs. Used by fare-split participant lists and public driver profile. Capped at 50 ids, active users only, authenticated only.';

REVOKE ALL ON FUNCTION public.get_public_display_names(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_public_display_names(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_public_display_names(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_display_names(uuid[]) TO service_role;
