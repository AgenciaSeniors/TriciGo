-- ============================================================
-- 00033 — Generate share_token on ride acceptance
-- ============================================================
-- Previously, share_token was only generated at ride completion
-- (in complete_ride_and_pay RPC). This trigger generates it at
-- acceptance so riders can share their live trip during the ride.
-- ============================================================

-- Function: generate share_token when ride transitions to 'accepted'
CREATE OR REPLACE FUNCTION generate_share_token_on_accept()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'accepted' AND OLD.status = 'searching'
     AND NEW.share_token IS NULL THEN
    NEW.share_token := encode(gen_random_bytes(12), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger fires BEFORE UPDATE so token is written atomically with status change
CREATE TRIGGER trg_share_token_on_accept
  BEFORE UPDATE ON rides
  FOR EACH ROW
  WHEN (NEW.status = 'accepted' AND OLD.status = 'searching')
  EXECUTE FUNCTION generate_share_token_on_accept();
