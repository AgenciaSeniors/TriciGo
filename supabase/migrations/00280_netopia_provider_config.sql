-- ============================================================
-- Migration 00280: NETOPIA provider configuration
--
-- Phase D2. Adds the platform_config rows that the NETOPIA
-- recharge edge function (create-netopia-payment-intent) reads:
-- signature, environment switch (sandbox/live), and the
-- recharge limit / fee parameters.
--
-- DESIGN — where keys live:
--   - SHORT identifiers (signature, environment, limits, fees)
--     → platform_config (this migration).
--   - LONG PEM certificates (private key, public key) → Supabase
--     Edge Function secrets / Deno environment variables, NOT
--     platform_config. PEM blobs are multi-line and best kept in
--     the platform's secret store. The edge function reads:
--       Deno.env.get('NETOPIA_SANDBOX_PRIVATE_KEY')
--       Deno.env.get('NETOPIA_SANDBOX_PUBLIC_KEY')
--       Deno.env.get('NETOPIA_LIVE_PRIVATE_KEY')
--       Deno.env.get('NETOPIA_LIVE_PUBLIC_KEY')
--     These are set by the operator via the Supabase dashboard
--     (Project Settings → Edge Functions → Secrets).
--
-- DESIGN — two environments side-by-side:
--   netopia_environment switches between 'sandbox' and 'live'.
--   Both signatures are stored so flipping the switch needs only
--   updating one row, not re-loading credentials.
--
-- Defaults are placeholders. The operator fills the signatures
-- from the NETOPIA dashboard (Puncte de vânzare → Setări tehnice
-- → Semnătură) after this migration is applied. Until set,
-- create-netopia-payment-intent returns 503 not_configured —
-- matches the Stripe behavior in the same situation.
--
-- ON CONFLICT DO NOTHING keeps this idempotent and never
-- overwrites a value the admin may have already changed.
-- ============================================================

INSERT INTO platform_config (key, value) VALUES
  -- Environment switch: 'sandbox' until live POS is approved by NETOPIA.
  ('netopia_environment', '"sandbox"'),

  -- Sandbox signature (from NETOPIA sandbox dashboard → Setări tehnice).
  -- Empty placeholder; operator sets after onboarding completes.
  ('netopia_sandbox_signature', '""'),

  -- Live signature (from NETOPIA live dashboard → Dezvoltare → Implementare).
  -- Empty placeholder; operator sets after the live POS is approved.
  ('netopia_live_signature', '""'),

  -- Per-transaction recharge limits (CUP). Same defaults as Stripe.
  ('netopia_min_recharge_cup', '500'),
  ('netopia_max_recharge_cup', '50000'),

  -- Platform fee added on top of the user-facing amount.
  ('netopia_fee_usd', '2.00'),
  ('netopia_fee_type', '"fixed"')
ON CONFLICT (key) DO NOTHING;
