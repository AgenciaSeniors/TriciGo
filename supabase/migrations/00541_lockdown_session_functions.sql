-- 00541: Re-cerrar EXECUTE de funciones que quedaron con PUBLIC en esta sesión
--
-- CONTEXTO (revisión de correctitud del trabajo de PR #922)
-- Al revisar los advisors tras aplicar 00538-00540 aparecieron 3 funciones
-- ejecutables por PUBLIC (anon/authenticated) que NO deberían serlo:
--
--   1. auto_offline_stale_drivers()  — la migración 00531 la había REVOCADO
--      explícitamente (es una función de mantenimiento que corre por cron), pero
--      el CREATE OR REPLACE de 00540 dejó la ACL en el default con PUBLIC. Un
--      usuario autenticado podía invocar el barrido de conductores stale + los
--      pushes de aviso. Impacto acotado (solo toca conductores ya stale >10 min,
--      lo mismo que el cron), pero era una capacidad cerrada a propósito.
--
--   2/3. tg_driver_profiles_shift_intent() y tg_rides_backstop_addresses() —
--      funciones-trigger nuevas (00540/00539). Llamarlas por RPC falla (referencian
--      contexto de trigger), así que no son explotables, pero ensucian los advisors.
--      Mismo patrón ya aplicado a resolve_point_address y check_stuck_active_rides.
--
-- service_role conserva EXECUTE (el cron corre como postgres/service-role).
-- driver_heartbeat NO se toca: authenticated DEBE poder llamarla (el conductor la
-- invoca cada 60 s) y se auto-autoriza internamente.
-- Idempotente: REVOKE de un privilegio ya ausente es un no-op.

REVOKE ALL ON FUNCTION public.auto_offline_stale_drivers()      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_driver_profiles_shift_intent() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_rides_backstop_addresses()     FROM PUBLIC, anon, authenticated;
