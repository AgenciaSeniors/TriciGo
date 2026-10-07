-- ============================================================
-- 00626 — the chat's "typing…" channel is private: only the ride's parties
--
-- WHY (audit 2026-10-06, Storage/Realtime area)
--   chatService.subscribeToTyping / broadcastTyping used a PUBLIC Realtime
--   channel `typing:{rideId}`, with presence. Public channels are not
--   authorization-gated (realtime.messages RLS only applies to private ones),
--   so anyone signed in who held a ride id could join it: see whether the
--   rider or the driver had the chat open (presence keys are user ids) and
--   broadcast fake "typing" events to them. No message text goes through it
--   (messages are postgres_changes on ride_messages, gated by its RLS).
--   Same class as RT-01 (rider-location, 00433) and RT-02 (ride-search, 00440).
--
-- WHAT
--   Read (SELECT) and write (INSERT) policies on realtime.messages for the
--   private topic typing:{rideId}, broadcast and presence, for the ride's
--   customer and assigned driver (is_ride_party, 00433). The apps switch the
--   channel to { private: true } in the same change.
--
-- ROLLOUT
--   Safe to apply before any app ships: these policies only gate PRIVATE
--   channels, and until the new builds there are none on this topic. Apply it
--   before the web deploy that carries the app change: a private channel with
--   no policy is denied, and the typing indicator would stop working there.
--   A private and a public channel with the same name never reach each other,
--   so an installed build (public) and a new one (private) do not see each
--   other type until both are updated.
-- ============================================================

SET lock_timeout = '5s';

-- "typing:" is 7 characters, so the ride UUID starts at character 8.
DROP POLICY IF EXISTS ride_typing_realtime_read ON realtime.messages;
CREATE POLICY ride_typing_realtime_read ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    extension IN ('broadcast', 'presence')
    AND realtime.topic() ~ '^typing:[0-9a-fA-F-]{36}$'
    AND public.is_ride_party(substring(realtime.topic() FROM 8)::uuid)
  );

DROP POLICY IF EXISTS ride_typing_realtime_write ON realtime.messages;
CREATE POLICY ride_typing_realtime_write ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    extension IN ('broadcast', 'presence')
    AND realtime.topic() ~ '^typing:[0-9a-fA-F-]{36}$'
    AND public.is_ride_party(substring(realtime.topic() FROM 8)::uuid)
  );

-- Assert the end state.
DO $check$
DECLARE
  -- As deparsed; the function shows schema-qualified when public is off the search_path.
  v_expr text := '((extension = ANY (ARRAY[''broadcast''::text, ''presence''::text])) AND (realtime.topic() ~ ''^typing:[0-9a-fA-F-]{36}$''::text) AND is_ride_party((SUBSTRING(realtime.topic() FROM 8))::uuid))';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                 WHERE polrelid = 'realtime.messages'::regclass AND polname = 'ride_typing_realtime_read'
                   AND polcmd = 'r' AND polpermissive
                   AND polroles = ARRAY['authenticated'::regrole::oid]
                   AND replace(pg_get_expr(polqual, polrelid), 'public.is_ride_party', 'is_ride_party') = v_expr
                   AND polwithcheck IS NULL) THEN
    RAISE EXCEPTION '00626: ride_typing_realtime_read is missing or not the 00626 policy';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                 WHERE polrelid = 'realtime.messages'::regclass AND polname = 'ride_typing_realtime_write'
                   AND polcmd = 'a' AND polpermissive
                   AND polroles = ARRAY['authenticated'::regrole::oid]
                   AND replace(pg_get_expr(polwithcheck, polrelid), 'public.is_ride_party', 'is_ride_party') = v_expr
                   AND polqual IS NULL) THEN
    RAISE EXCEPTION '00626: ride_typing_realtime_write is missing or not the 00626 policy';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'realtime.messages'::regclass) THEN
    RAISE EXCEPTION '00626: RLS is off on realtime.messages, so these policies gate nothing';
  END IF;
END
$check$;

RESET lock_timeout;
