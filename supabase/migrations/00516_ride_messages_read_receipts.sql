-- 00516: read receipts for the in-ride chat.
--
-- The driver's ChatBubble has rendered a single/double check since it was
-- written, but the screen passes `isRead={false}` unconditionally — there was
-- nothing in the database to derive it from, so the double check was
-- unreachable code and the single check meant nothing.
--
-- Unread state has the same gap from the other side: the rider's badge counts
-- "messages newer than the `chat_last_read_<rideId>` timestamp this device
-- happens to hold in AsyncStorage". That is per-device, does not survive a
-- reinstall, and two devices signed into the same account disagree.
--
-- One column fixes both: read_at is the shared fact the sender's check mark and
-- the recipient's badge both read from.
--
-- WHY AN RPC AND NOT AN UPDATE POLICY
-- ride_messages has SELECT and INSERT policies and deliberately no UPDATE
-- policy: a sent message is immutable. Opening UPDATE so the recipient can
-- stamp read_at would also open `body` to editing — RLS grants apply to the
-- row, not to a column, and a WITH CHECK cannot express "only this column may
-- change". A SECURITY DEFINER function performing one fixed UPDATE keeps the
-- content immutable while allowing exactly one state transition. Same shape as
-- get_delivery_details_for_ride (00511): the table stays closed, a narrow
-- function is the only door.
--
-- Admins are deliberately NOT allowed to mark messages read. An admin reading a
-- chat to investigate a dispute must not make it look like the recipient read
-- it — that would corrupt the very evidence they came to look at.

ALTER TABLE public.ride_messages
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

COMMENT ON COLUMN public.ride_messages.read_at IS
  '00516: when the RECIPIENT opened the chat and saw this message. Written only '
  'by mark_ride_messages_read(); the table has no UPDATE policy, so message '
  'content stays immutable.';

-- Partial index: every query on this column asks for the unread ones.
CREATE INDEX IF NOT EXISTS idx_ride_messages_unread
  ON public.ride_messages (ride_id, sender_id)
  WHERE read_at IS NULL;

CREATE OR REPLACE FUNCTION public.mark_ride_messages_read(p_ride_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_customer_id UUID;
  v_driver_id   UUID;
  v_participant BOOLEAN := false;
  v_marked      INTEGER := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN 0;
  END IF;

  SELECT r.customer_id, r.driver_id INTO v_customer_id, v_driver_id
  FROM rides r WHERE r.id = p_ride_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- COALESCE on both predicates is load-bearing, not defensive noise. A caller
  -- with no driver_profiles row makes the sub-select NULL, so
  -- `v_driver_id = NULL` yields NULL rather than false; `false OR NULL` is
  -- NULL, `NOT NULL` is NULL, and the deny branch never runs — the gate would
  -- fail OPEN. That exact bug was caught in 00511 by running the function under
  -- impersonation rather than reading it.
  v_participant :=
    COALESCE(v_customer_id = auth.uid(), false)
    OR COALESCE(v_driver_id = (
         SELECT dp.id FROM driver_profiles dp WHERE dp.user_id = auth.uid()
       ), false);

  IF NOT v_participant THEN
    RETURN 0;
  END IF;

  -- `sender_id <> auth.uid()` is what makes this a read receipt rather than a
  -- self-serve timestamp: you can only mark what was sent TO you.
  UPDATE ride_messages
     SET read_at = now()
   WHERE ride_id = p_ride_id
     AND sender_id <> auth.uid()
     AND read_at IS NULL;

  GET DIAGNOSTICS v_marked = ROW_COUNT;
  RETURN v_marked;
END;
$function$;

COMMENT ON FUNCTION public.mark_ride_messages_read(UUID) IS
  '00516: stamps read_at on the messages of this ride that the caller RECEIVED '
  'and had not yet read. Participants only (customer or assigned driver); admins '
  'excluded on purpose so investigating a dispute cannot forge a read receipt. '
  'Returns how many rows were marked.';

REVOKE ALL ON FUNCTION public.mark_ride_messages_read(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_ride_messages_read(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_ride_messages_read(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_ride_messages_read(UUID) TO service_role;
