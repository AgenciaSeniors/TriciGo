-- ============================================================
-- 00517 — Stop serving platform_config secrets to the public API key
--
-- RENUMBERED from 00516. Two parallel sessions both picked 00516 and both
-- landed: this one (#875) and `00516_ride_messages_read_receipts.sql` (#871).
-- This file moved rather than that one because the chat number is cited in
-- 14+ code comments across apps/ and packages/ (useUnreadChatCount, the chat
-- screens, chat.service, its tests, the shared types, the admin ride detail),
-- while this number appeared only inside this file. Fewer moving parts wins
-- over "whoever applied first keeps the number" — this one was applied first.
--
-- ALREADY APPLIED TO PRODUCTION under the old filename. Both migrations were
-- applied through the MCP, which registers `version` as a TIMESTAMP, not as
-- the number — so the rename cannot cause a re-apply. In
-- `supabase_migrations.schema_migrations` this row still reads
-- `version 20260727040806, name 00516_platform_config_hide_secrets_from_anon`,
-- and the COMMENT text on the function and table still says 00516. That drift
-- is cosmetic and deliberately left alone: rewriting comments in production to
-- match a file rename is not worth a second write. Verify by object, never by
-- migration number.
--
-- `platform_config` held its SELECT policy as `USING (true)` for role
-- `public`, and `anon` carries a table-level SELECT grant. PostgREST has
-- no further gate, so every row was readable by anyone holding the
-- publishable key — which ships inside both mobile APKs and the web
-- bundle, and is extractable from any install.
--
-- Among those rows:
--
--     netopia_live_signature      live payment signature
--     netopia_sandbox_signature
--     eltoque_api_token           FX provider JWT
--     infobip_api_key             messaging
--     smspm_token / smspm_hash    SMS
--     openweather_api_key
--
-- Writes were never exposed (INSERT/UPDATE/DELETE are `is_super_admin()`),
-- so this was read-only disclosure. It is still credential disclosure.
--
-- WHY A PATTERN AND NOT A STRICT ALLOW-LIST
--
-- An allow-list would require enumerating every key any client reads.
-- Some are built dynamically — `payment.service.ts` reads
-- `${provider}_enabled`, `${provider}_publishable_key`,
-- `${provider}_min_recharge_cup`, … — so a missed key means a payment or
-- recharge path breaking silently in production. Classifying by NAME
-- instead is fail-closed in the direction that matters: a secret added
-- later under any of the conventional suffixes is hidden by default,
-- without anyone having to remember to update a list.
--
-- Verified against the 100 live rows before applying: exactly 8 become
-- admin-only (the 7 above plus `cron_http_health_signature`, watchdog
-- state that only SECURITY DEFINER code reads); the other 91 stay
-- public, including every key the apps are known to read.
--
-- `%publishable%` is excluded on purpose: a publishable key is public by
-- definition, and blocking `stripe_publishable_key` would break the
-- Stripe recharge path the moment that provider is switched on.
--
-- Edge Functions and SQL functions are unaffected — they run as
-- `service_role` / SECURITY DEFINER and bypass RLS entirely. The admin
-- panel keeps full visibility through `is_admin()`.
-- ============================================================

CREATE OR REPLACE FUNCTION public.platform_config_is_secret(p_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT p_key NOT ILIKE '%publishable%'
     AND (
       p_key ~ '(_token|_secret|_signature|_hash|_api_key|_password)$'
       OR p_key IN (
         'eltoque_api_token',
         'infobip_api_key',
         'openweather_api_key',
         'smspm_token',
         'smspm_hash',
         'netopia_live_signature',
         'netopia_sandbox_signature'
       )
     );
$$;

COMMENT ON FUNCTION public.platform_config_is_secret(TEXT) IS
  'True for platform_config keys that must never reach the public API key. '
  'Classified by naming convention so a secret added later is hidden by '
  'default. Used by the pc_select RLS policy (00517).';

-- `is_admin()` CANNOT be used directly in this policy. It calls
-- `current_user_role()`, which `anon` has no EXECUTE grant on, so the
-- policy would raise `42501: permission denied` on every anonymous read
-- — taking down not just the secrets but every public config read the
-- apps depend on. (Found by running the policy as `anon` in a
-- rolled-back transaction; reading the policy would never have shown
-- it.) Relying on OR/AND short-circuiting is not a fix either: Postgres
-- is free to reorder those.
--
-- This wrapper is SECURITY DEFINER, so the role check runs with the
-- owner's rights, and it fails CLOSED — no session, or any error at all,
-- means "not an admin", which denies the secret rather than exposing it.
CREATE OR REPLACE FUNCTION public.platform_config_can_read_secrets()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN COALESCE(is_admin(), false);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.platform_config_can_read_secrets() TO anon, authenticated;

DROP POLICY IF EXISTS pc_select ON public.platform_config;

CREATE POLICY pc_select ON public.platform_config
  FOR SELECT
  USING (
    NOT public.platform_config_is_secret(key)
    OR public.platform_config_can_read_secrets()
  );

COMMENT ON TABLE public.platform_config IS
  'Platform tunables. READABLE BY THE PUBLIC API KEY except keys matching '
  'platform_config_is_secret() (00517) — anon holds a SELECT grant and the '
  'publishable key ships in every app build. Never add a credential here '
  'under a name that does not end in _token/_secret/_signature/_hash/'
  '_api_key/_password, or it will be served publicly. Writes are '
  'super_admin-only (00292).';
