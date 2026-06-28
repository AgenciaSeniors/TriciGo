-- 00433_rider_location_private_channel.sql
-- ============================================================================
-- RT-01 (pre-launch audit round 6, P2 PRIVACY): the rider's live GPS was
-- broadcast on a PUBLIC Supabase Realtime channel `rider-location:{rideId}`
-- during the pickup phase. Public broadcast channels are NOT authorization-gated
-- (realtime.messages RLS only applies to PRIVATE channels), so any authenticated
-- user who obtained a ride UUID (from a shared tracking link, deep link, support
-- context, logs) could subscribe and passively track the rider's live location —
-- below the bar already set for the symmetric driver path (get_driver_position
-- RPC, which is gated). Fix: switch the channel to PRIVATE in all three apps
-- (client emitter, web emitter, driver consumer) and authorize the topic here via
-- RLS on realtime.messages so only the ride's customer + assigned driver can
-- send/receive on it.
--
-- ⚠️ DO NOT APPLY THIS MIGRATION ALONE. A private channel with no policy
-- default-denies → the live-rider-pin feature breaks. The app code that switches
-- the channel to `{ config: { private: true } }` ships in the v6 mobile rebuild
-- (+ web deploy). Apply this migration TOGETHER with that rebuild, and validate
-- the realtime auth handshake (supabase.realtime.setAuth()) in a real build before
-- relying on it. Until then the currently-shipped apps use the public channel and
-- these policies have no effect (they only gate private channels, of which there
-- are none today).
-- ============================================================================

-- Is the current caller a party (customer or assigned driver) to this ride?
CREATE OR REPLACE FUNCTION public.is_ride_party(p_ride_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM rides r
    WHERE r.id = p_ride_id
      AND (
        r.customer_id = auth.uid()
        OR r.driver_id IN (SELECT dp.id FROM driver_profiles dp WHERE dp.user_id = auth.uid())
      )
  );
$function$;

GRANT EXECUTE ON FUNCTION public.is_ride_party(uuid) TO authenticated;

-- Authorize the rider-location:{rideId} broadcast topic to ride parties only.
-- "rider-location:" is 15 chars, so the ride UUID starts at character 16.
DROP POLICY IF EXISTS rider_location_broadcast_read ON realtime.messages;
CREATE POLICY rider_location_broadcast_read ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    extension = 'broadcast'
    AND realtime.topic() ~ '^rider-location:[0-9a-fA-F-]{36}$'
    AND public.is_ride_party(substring(realtime.topic() FROM 16)::uuid)
  );

DROP POLICY IF EXISTS rider_location_broadcast_write ON realtime.messages;
CREATE POLICY rider_location_broadcast_write ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    extension = 'broadcast'
    AND realtime.topic() ~ '^rider-location:[0-9a-fA-F-]{36}$'
    AND public.is_ride_party(substring(realtime.topic() FROM 16)::uuid)
  );
