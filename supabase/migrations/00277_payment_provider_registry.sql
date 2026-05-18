-- ============================================================
-- Migration 00277: Payment provider registry
--
-- Phase D1 of the payment-processor onboarding plan. Seeds the
-- platform_config rows that make the payment-provider abstraction
-- explicit: which provider is active for new recharges, and which
-- providers are enabled.
--
-- Today the only integrated provider is Stripe. NETOPIA and
-- EuPlatesc are registered here as disabled placeholders; their
-- credential keys (netopia_secret_key, netopia_webhook_secret, etc.)
-- are added when those integrations land (Phases D2 / D3). See
-- docs/payment-processor/PAYMENT_PROVIDER_CONTRACT.md.
--
-- value is jsonb: 'false' is the JSON boolean false; '"stripe"' is a
-- JSON string. ON CONFLICT DO NOTHING keeps this idempotent and never
-- overwrites a value an admin may have already changed.
-- ============================================================

INSERT INTO platform_config (key, value) VALUES
  ('active_payment_provider', '"stripe"'),
  ('netopia_enabled',   'false'),
  ('euplatesc_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
