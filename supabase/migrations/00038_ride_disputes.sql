-- ============================================================================
-- Migration 00038: Formal Ride Disputes
-- ============================================================================
-- Structured dispute resolution for completed rides.
-- Supports: reason taxonomy, two-party response, admin review,
-- refund processing, SLA tracking, and evidence uploads.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ride_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id UUID NOT NULL REFERENCES rides(id),
  opened_by UUID NOT NULL REFERENCES auth.users(id),
  reason TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_urls TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',

  -- Respondent (the other party in the ride)
  respondent_id UUID REFERENCES auth.users(id),
  respondent_message TEXT,
  respondent_evidence_urls TEXT[] NOT NULL DEFAULT '{}',
  respondent_replied_at TIMESTAMPTZ,

  -- Resolution
  resolution TEXT,
  resolution_notes TEXT,
  refund_amount_trc INTEGER,
  refund_transaction_id UUID,

  -- Admin handling
  assigned_to UUID REFERENCES auth.users(id),
  admin_notes TEXT,

  -- SLA tracking
  sla_first_response_at TIMESTAMPTZ,
  sla_resolution_deadline TIMESTAMPTZ,

  -- Cross-references to existing systems
  support_ticket_id UUID REFERENCES support_tickets(id),
  incident_report_id UUID,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,

  -- Only one dispute per ride at a time
  CONSTRAINT one_dispute_per_ride UNIQUE (ride_id)
);

-- Indexes
CREATE INDEX idx_ride_disputes_ride ON ride_disputes(ride_id);
CREATE INDEX idx_ride_disputes_opened_by ON ride_disputes(opened_by, created_at DESC);
CREATE INDEX idx_ride_disputes_status ON ride_disputes(status, created_at DESC);
CREATE INDEX idx_ride_disputes_assigned ON ride_disputes(assigned_to, status);

-- Auto-update updated_at
CREATE TRIGGER set_ride_disputes_updated_at
  BEFORE UPDATE ON ride_disputes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- RLS Policies
-- ============================================================
ALTER TABLE ride_disputes ENABLE ROW LEVEL SECURITY;

-- Participants and admins can read disputes
CREATE POLICY "dispute_select" ON ride_disputes FOR SELECT USING (
  opened_by = auth.uid()
  OR respondent_id = auth.uid()
  OR is_admin()
);

-- Ride participants can open disputes on completed/disputed rides
CREATE POLICY "dispute_insert" ON ride_disputes FOR INSERT WITH CHECK (
  opened_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM rides
    WHERE rides.id = ride_id
      AND (rides.customer_id = auth.uid() OR rides.driver_id IN (
        SELECT dp.id FROM driver_profiles dp WHERE dp.user_id = auth.uid()
      ))
      AND rides.status IN ('completed', 'disputed')
  )
);

-- Respondent can update their response; admins can update anything
CREATE POLICY "dispute_update" ON ride_disputes FOR UPDATE USING (
  respondent_id = auth.uid()
  OR is_admin()
);
