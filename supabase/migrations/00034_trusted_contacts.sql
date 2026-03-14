-- ============================================================================
-- Migration 00034: Trusted Contacts
-- ============================================================================
-- Normalizes emergency contacts into a dedicated table supporting multiple
-- trusted contacts per user with auto-share and emergency flags.
-- ============================================================================

-- Create trusted_contacts table
CREATE TABLE trusted_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT '',
  auto_share BOOLEAN NOT NULL DEFAULT true,
  is_emergency BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, phone)
);

CREATE INDEX idx_trusted_contacts_user ON trusted_contacts(user_id);
CREATE INDEX idx_trusted_contacts_auto_share ON trusted_contacts(user_id) WHERE auto_share = true;

-- RLS
ALTER TABLE trusted_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own contacts"
  ON trusted_contacts FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert own contacts"
  ON trusted_contacts FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own contacts"
  ON trusted_contacts FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own contacts"
  ON trusted_contacts FOR DELETE
  USING (user_id = auth.uid());

-- Service role bypass
CREATE POLICY "Service role full access on trusted_contacts"
  ON trusted_contacts FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Auto-update updated_at
CREATE TRIGGER trg_trusted_contacts_updated
  BEFORE UPDATE ON trusted_contacts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- Data migration: copy existing emergency contacts from customer_profiles
-- ============================================================================
INSERT INTO trusted_contacts (user_id, name, phone, relationship, auto_share, is_emergency)
SELECT
  cp.user_id,
  cp.emergency_contact->>'name',
  cp.emergency_contact->>'phone',
  COALESCE(cp.emergency_contact->>'relationship', ''),
  true,
  true
FROM customer_profiles cp
WHERE cp.emergency_contact IS NOT NULL
  AND cp.emergency_contact->>'phone' IS NOT NULL
  AND cp.emergency_contact->>'phone' != ''
ON CONFLICT (user_id, phone) DO NOTHING;
