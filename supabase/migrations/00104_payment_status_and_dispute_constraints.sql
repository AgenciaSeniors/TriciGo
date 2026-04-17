-- ============================================================
-- Migration 00104: Add CHECK constraints for text columns
-- BUG-095: payment_status is TEXT without constraint
-- BUG-096: Dispute enums without DB enforcement
-- BUG-101: RLS policy logic error — delivery_details NULL driver_id
-- ============================================================

-- BUG-095: Add CHECK constraint on rides.payment_status
ALTER TABLE rides
  ADD CONSTRAINT chk_payment_status_valid
    CHECK (payment_status IS NULL OR payment_status IN (
      'pending', 'authorized', 'captured', 'completed', 'failed', 'refunded', 'partially_refunded', 'not_applicable'
    ));

-- BUG-096: Add CHECK constraints on ride_disputes text columns
ALTER TABLE ride_disputes
  ADD CONSTRAINT chk_dispute_status_valid
    CHECK (status IN (
      'open', 'under_review', 'resolved_rider', 'resolved_driver', 'escalated', 'closed'
    ));

ALTER TABLE ride_disputes
  ADD CONSTRAINT chk_dispute_priority_valid
    CHECK (priority IN ('low', 'medium', 'high', 'critical'));

-- BUG-101: Fix RLS policy — prevent driver UPDATE when rides.driver_id is NULL
-- Drop and recreate the policy with explicit NOT NULL check
DO $$
BEGIN
  -- Only update if the policy exists
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'delivery_details'
    AND policyname LIKE '%driver%update%'
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS "Drivers can update delivery details" ON delivery_details';
    EXECUTE '
      CREATE POLICY "Drivers can update delivery details" ON delivery_details
        FOR UPDATE TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM rides
            WHERE rides.id = delivery_details.ride_id
            AND rides.driver_id IS NOT NULL
            AND rides.driver_id = (
              SELECT id FROM driver_profiles WHERE user_id = auth.uid()
            )
          )
        )
    ';
  END IF;
END $$;
