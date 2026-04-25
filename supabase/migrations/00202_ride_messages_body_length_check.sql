-- ============================================================
-- BUG-159: ride_messages.body has no length CHECK constraint, so
-- a participant could insert a 10 MB message and clog the chat
-- realtime feed + bloat the DB. The longest current message is
-- 11 chars and there are no empty bodies, so a 1..2000 cap is
-- safe to add as VALIDATED immediately.
-- ============================================================

ALTER TABLE public.ride_messages
  ADD CONSTRAINT ride_messages_body_length_check
  CHECK (length(body) BETWEEN 1 AND 2000) NOT VALID;

ALTER TABLE public.ride_messages
  VALIDATE CONSTRAINT ride_messages_body_length_check;
