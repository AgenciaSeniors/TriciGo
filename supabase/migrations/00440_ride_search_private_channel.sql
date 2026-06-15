-- 00440_ride_search_private_channel.sql
-- ============================================================================
-- RT-02 (pre-launch audit round 8, P2 PRIVACY): the ride-search presence/broadcast
-- channel `ride-search:{rideId}` was PUBLIC. Public Supabase Realtime channels are
-- NOT authorization-gated, so any authenticated user holding a ride UUID could join
-- and read every reviewing driver's tracked presence — name, photo, rating, vehicle
-- type (incl. plate) and live location — plus the driver_accepted broadcast. Same
-- class as RT-01 (rider-location). Fix: switch the channel to PRIVATE in
-- presence.service.ts (the single shared call site for client/driver/web) and
-- authorize the topic here via RLS on realtime.messages.
--
-- Authorized set for ride-search:{rideId}:
--   * the ride's customer (subscribes to see drivers), AND
--   * a driver with an ACTIVE offer for that ride (joins presence to advertise).
--
-- ⚠️ DO NOT APPLY ALONE. A private channel with no policy default-denies → the
-- "drivers reviewing your ride" presence + fast-accept broadcast break. The app code
-- (presence.service.ts → { config: { private: true } } + supabase.realtime.setAuth())
-- ships in the v6 build (+ web deploy); apply this migration TOGETHER with it and
-- validate the realtime auth handshake in a real build. Until then the shipped apps
-- use the public channel and this policy has no effect (it only gates private
-- channels, of which there are none today). Pairs with RT-01 / mig 00433 (#543).
-- ============================================================================

-- May the current caller access the ride-search topic for this ride?
CREATE OR REPLACE FUNCTION public.can_access_ride_search(p_ride_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT
    EXISTS (
      SELECT 1 FROM rides r WHERE r.id = p_ride_id AND r.customer_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM ride_offers ro
      JOIN driver_profiles dp ON dp.id = ro.driver_profile_id
      WHERE ro.ride_id = p_ride_id
        AND dp.user_id = auth.uid()
        AND (ro.expires_at IS NULL OR ro.expires_at > now())
    );
$function$;

GRANT EXECUTE ON FUNCTION public.can_access_ride_search(uuid) TO authenticated;

-- Authorize the ride-search:{rideId} private presence + broadcast topic.
-- "ride-search:" is 12 chars, so the ride UUID starts at character 13.
DROP POLICY IF EXISTS ride_search_realtime_read ON realtime.messages;
CREATE POLICY ride_search_realtime_read ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    extension IN ('broadcast', 'presence')
    AND realtime.topic() ~ '^ride-search:[0-9a-fA-F-]{36}$'
    AND public.can_access_ride_search(substring(realtime.topic() FROM 13)::uuid)
  );

DROP POLICY IF EXISTS ride_search_realtime_write ON realtime.messages;
CREATE POLICY ride_search_realtime_write ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    extension IN ('broadcast', 'presence')
    AND realtime.topic() ~ '^ride-search:[0-9a-fA-F-]{36}$'
    AND public.can_access_ride_search(substring(realtime.topic() FROM 13)::uuid)
  );
