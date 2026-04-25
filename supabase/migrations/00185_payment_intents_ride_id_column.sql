-- ============================================================
-- BUG-128: process-tropipay-webhook reads payment_intents.ride_id
-- in two paths (the GET-redirect handler and the POST webhook
-- handler) but the column doesn't exist on payment_intents — same
-- shape as BUG-127 with intent_type. Effect: when a customer pays
-- a ride directly through TropiPay (intent_type='ride_payment')
-- and the redirect lands on the success URL, the SELECT errors
-- out before any RPC is called. The TropiPay payment is never
-- credited, the ride.payment_status stays 'pending', and the
-- driver thinks the rider stiffed them.
--
-- Same fix pattern as 00184: add the column so the EF code keeps
-- working without a redeploy. ride_id references rides(id) so a
-- bad value would surface immediately as a FK error.
-- ============================================================

ALTER TABLE public.payment_intents
  ADD COLUMN IF NOT EXISTS ride_id uuid REFERENCES public.rides(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payment_intents_ride_id
  ON public.payment_intents(ride_id)
  WHERE ride_id IS NOT NULL;

COMMENT ON COLUMN public.payment_intents.ride_id IS
  'BUG-128: present so process-tropipay-webhook can join an intent back to its ride for ride_payment intents (intent_type=''ride_payment''). Set during create-ride-payment-link and read by both the GET-redirect handler and the POST webhook.';
