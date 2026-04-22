-- ============================================================
-- Migration 00146: add `extensions` to complete_ride_and_pay search_path
--
-- `complete_ride_and_pay` (the completion RPC invoked by the driver
-- tap on "Finalizar viaje") executes `encode(gen_random_bytes(12), 'hex')`
-- to generate a share token. pgcrypto's `gen_random_bytes` lives in the
-- `extensions` schema, but the function declares
--   SET search_path = 'public', 'pg_catalog'
-- which does NOT include extensions. Result: every completion attempt
-- fails with 42883 "function gen_random_bytes(integer) does not exist"
-- and the ride stays stuck in arrived_at_destination.
--
-- Fix: extend search_path to include extensions. This mirrors what
-- migration 00145 did for generate_share_token_on_accept (which took
-- the explicit-qualification approach). Here the function body is
-- much larger, so the search_path tweak is less invasive.
-- ============================================================

ALTER FUNCTION public.complete_ride_and_pay(uuid, uuid, integer, integer)
SET search_path = 'public', 'extensions', 'pg_catalog';
