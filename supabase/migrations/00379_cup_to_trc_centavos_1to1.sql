-- ============================================================
-- 00379 — TriciCoin es 1:1 con CUP: cup_to_trc_centavos debe devolver el CUP.
--
-- BUG (verificado en prod 2026-06-04, ride c3c61627):
--   Viaje auto_confort en TriciCoin cotizado 7200 TRC, pero al cliente se le
--   debitaron solo 1180 TRC. Ledger desbalanceado:
--     customer_cash -1180 · platform_revenue +1080 · tricicoin(driver) +6120
--   → −1180 ≠ −(6120+1080): se "crearon" 6020. El driver + plataforma cobraron
--   en CUP (7200) pero el cliente pagó en centavos-USD (1180).
--
-- CAUSA RAÍZ:
--   TriciCoin es 1:1 con CUP en TODO el sistema (CLAUDE.md "1 TRC = 1 CUP";
--   packages/utils/src/currency.ts "TRC = whole units, 1 TRC = 1 CUP";
--   wallet_accounts "Balance in TRC whole units"; las recargas acreditan
--   amount_cup; cupToTrc() del estimado es identidad → estimated_fare_trc=7200).
--   PERO la versión VIVA de cup_to_trc_centavos quedó con la fórmula pre-rebase
--   ROUND(cup / rate * 100) (centavos-USD), pese a que la migración 00094
--   documentó que debía devolver ROUND(cup) (1:1). complete_ride_and_pay usa
--   esa función para v_final_fare_trc y DEBITA eso al cliente, mientras acredita
--   driver/plataforma en CUP → mismatch de unidad → subcobro ~6x + ledger roto.
--
-- FIX:
--   Restaurar la definición 1:1 (intención de 00094). El param exchange_rate se
--   conserva por compatibilidad de firma pero se IGNORA. Esto arregla TODOS los
--   callers vivos (verificado: complete_ride_and_pay [fare + seguro],
--   admin_reward_referral, trg_referral_reward_on_complete,
--   trg_referral_reward_on_driver_approved — todos hacen
--   `v_X_trc := cup_to_trc_centavos(v_X_cup, rate)` y lo usan 1:1, ninguno
--   compensa). Con esto: final_fare_trc = 7200, débito cliente = 7200, y el
--   ledger del ride suma 0 (−7200 + 6120 + 1080).
--
-- Históricos: los 2 viajes ya afectados (c3c61627, ebee76d5) son cuentas de
--   prueba y se DEJAN como están (decisión del usuario 2026-06-04) — su
--   desbalance no se reconcilia.
--
-- NOT applied to prod yet (MCP guard). Aplicar tras autorización explícita.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cup_to_trc_centavos(p_cup_pesos numeric, p_exchange_rate numeric)
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  -- Rebase 00094: 1 TRC = 1 CUP (sin centavos). Devolver el CUP tal cual.
  -- p_exchange_rate se ignora (se conserva por compatibilidad de firma).
  RETURN ROUND(p_cup_pesos);
END;
$function$;

COMMENT ON FUNCTION public.cup_to_trc_centavos(numeric, numeric) IS
  '00379: TriciCoin 1:1 con CUP (restaura intención de 00094). Devuelve ROUND(cup); '
  'ignora el exchange_rate. La versión previa (centavos-USD ROUND(cup/rate*100)) '
  'subcobraba ~6x a clientes tricicoin/mixed y desbalanceaba el ledger.';
