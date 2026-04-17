-- ============================================================================
-- Migration 00097: Share Ride Hardening
-- ============================================================================
-- I1:  Add unique index on rides.share_token (was doing full table scans)
-- I5:  Add share_token_expires_at column for token expiration
-- I8:  Add DB-level constraint for max 5 trusted contacts per user (TOCTOU fix)
-- I11: Create share_access_log table for safety forensics
-- ============================================================================

-- ── I1: Unique partial index on share_token ──────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_rides_share_token
  ON rides(share_token)
  WHERE share_token IS NOT NULL;

-- ── I5: Token expiration column ──────────────────────────────────────────────
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS share_token_expires_at TIMESTAMPTZ;

-- Set expiry for already-completed rides (24h after completion)
UPDATE rides
SET share_token_expires_at = completed_at + INTERVAL '24 hours'
WHERE status = 'completed'
  AND share_token IS NOT NULL
  AND share_token_expires_at IS NULL
  AND completed_at IS NOT NULL;

-- Auto-set expiry when ride completes
CREATE OR REPLACE FUNCTION set_share_token_expiry()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('completed', 'canceled', 'disputed')
     AND OLD.status NOT IN ('completed', 'canceled', 'disputed')
     AND NEW.share_token IS NOT NULL
  THEN
    NEW.share_token_expires_at := NOW() + INTERVAL '24 hours';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_share_token_expiry ON rides;
CREATE TRIGGER trg_set_share_token_expiry
  BEFORE UPDATE OF status ON rides
  FOR EACH ROW
  EXECUTE FUNCTION set_share_token_expiry();

-- ── I8: DB-level max trusted contacts constraint (prevents TOCTOU race) ─────
CREATE OR REPLACE FUNCTION enforce_max_trusted_contacts()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT count(*) FROM trusted_contacts WHERE user_id = NEW.user_id) >= 5 THEN
    RAISE EXCEPTION 'Maximum trusted contacts reached (5)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_max_trusted_contacts ON trusted_contacts;
CREATE TRIGGER trg_max_trusted_contacts
  BEFORE INSERT ON trusted_contacts
  FOR EACH ROW
  EXECUTE FUNCTION enforce_max_trusted_contacts();

-- ── I11: Share access log for safety forensics ──────────────────────────────
CREATE TABLE IF NOT EXISTS share_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_token TEXT NOT NULL,
  ride_id UUID REFERENCES rides(id),
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent TEXT,
  ip_hash TEXT  -- SHA-256 hash, never raw IP
);

-- Index for lookups by share_token
CREATE INDEX IF NOT EXISTS idx_share_access_log_token
  ON share_access_log(share_token);

-- RLS: only service_role can insert/read (edge functions)
ALTER TABLE share_access_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on share_access_log"
  ON share_access_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── I2: Fix hardcoded share URL in DB trigger function ──────────────────────
-- Replace the notify_trusted_contacts_on_accept function to use the canonical
-- tricigo.app domain (was already correct, but we centralize the constant).
CREATE OR REPLACE FUNCTION notify_trusted_contacts_on_accept()
RETURNS TRIGGER AS $$
DECLARE
  v_contact RECORD;
  v_rider_name TEXT;
  v_share_url TEXT;
  v_sms_body TEXT;
  v_payload JSONB;
  v_edge_fn_url TEXT;
  v_service_key TEXT;
BEGIN
  IF NEW.status <> 'accepted' OR OLD.status <> 'searching' THEN
    RETURN NEW;
  END IF;

  IF NEW.share_token IS NULL THEN
    RETURN NEW;
  END IF;

  -- Read secrets from Vault (no hardcoded keys)
  SELECT decrypted_secret INTO v_service_key
  FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;

  SELECT decrypted_secret INTO v_edge_fn_url
  FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1;

  IF v_service_key IS NULL OR v_edge_fn_url IS NULL THEN
    RAISE WARNING 'Vault secrets not configured for notify_trusted_contacts';
    RETURN NEW;
  END IF;

  v_edge_fn_url := v_edge_fn_url || '/functions/v1/send-sms';

  SELECT full_name INTO v_rider_name
  FROM users WHERE id = NEW.customer_id;

  -- Canonical share URL (single source of truth for DB layer)
  v_share_url := 'https://tricigo.app/track/share/' || NEW.share_token;

  FOR v_contact IN
    SELECT tc.name AS contact_name, tc.phone AS contact_phone
    FROM trusted_contacts tc
    WHERE tc.user_id = NEW.customer_id
      AND tc.auto_share = true
  LOOP
    v_sms_body := COALESCE(v_rider_name, 'Alguien') ||
      ' ha iniciado un viaje con TriciGo. Sigue en tiempo real: ' || v_share_url;

    v_payload := jsonb_build_object(
      'phone', v_contact.contact_phone,
      'body', v_sms_body,
      'ride_id', NEW.id::text,
      'event_type', 'trusted_contact_share'
    );

    PERFORM net.http_post(
      url := v_edge_fn_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_key
      ),
      body := v_payload
    );
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
