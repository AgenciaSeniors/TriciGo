-- ============================================================
-- Migration 00285: trigger para mantener wallet_accounts.balance_usd_cents
--                  sincronizado cuando wallet_accounts.balance cambia,
--                  + backfill one-time de cuentas desincronizadas.
--
-- Cierra el gap dejado por 00242 (Wallet v2 USD data layer). Esa
-- migración agregó las columnas `balance_usd_cents` / `held_balance_usd_cents`
-- y populó valores iniciales con un snapshot del exchange rate, pero
-- NO instaló trigger ni hook para mantener el USD sincronizado cuando
-- futuras mutations cambien `balance`.
--
-- Síntoma observado: user con `balance = 10,000` ve `$0.00` en el
-- Wallet tab (BalanceBadge prioriza balance_usd_cents si != null;
-- aunque sea 0). Causa: Stripe recharge / NETOPIA recharge / PR #144
-- wallet-routing move / ride payments / admin corrections updateaban
-- `balance` dejando `balance_usd_cents` en 0 o stale snapshot.
--
-- El TS-side ya tiene un fallback defensivo (BalanceBadge muestra el
-- legacy `balance` cuando USD-cents está 0). Esta migración cierra el
-- root cause: garantiza que ambos campos quedan coherentes a futuro
-- + reconcilia las cuentas existentes que ya quedaron desincronizadas.
-- ============================================================

-- ── 1) Función + trigger de sincronización ──
CREATE OR REPLACE FUNCTION public.sync_wallet_balance_usd()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_rate NUMERIC;
BEGIN
  -- Resolver exchange rate con preferencia:
  --   1) migration_rate snapshot (00242) — pegged al momento de migrar,
  --      mantiene holdings históricos valuados consistentemente.
  --   2) platform_config.exchange_rate_usd_cup — rate live.
  --   3) get_current_exchange_rate() — helper que retorna el más reciente.
  --   4) NULL si todo falla → preservamos el valor previo (no rompemos
  --      el UPDATE).
  v_rate := COALESCE(
    NEW.migration_rate,
    (SELECT (value #>> '{}')::NUMERIC FROM platform_config WHERE key = 'exchange_rate_usd_cup'),
    get_current_exchange_rate()
  );

  IF v_rate IS NOT NULL AND v_rate > 0 THEN
    NEW.balance_usd_cents      := ROUND(NEW.balance * 100.0 / v_rate);
    NEW.held_balance_usd_cents := ROUND(COALESCE(NEW.held_balance, 0) * 100.0 / v_rate);
  END IF;
  -- Si no hay rate, dejamos los USD-cents como vinieron — el fallback
  -- defensivo de BalanceBadge se encarga del display.

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.sync_wallet_balance_usd IS
  '00285: mantiene wallet_accounts.balance_usd_cents en sync con balance '
  'al UPDATE. Usa migration_rate snapshot (00242) si existe, sino '
  'platform_config.exchange_rate_usd_cup live, sino get_current_exchange_rate(). '
  'Cierra gap del 00242 que no instaló este hook → Stripe / NETOPIA / '
  'PR #144 / ride_payments updateaban balance dejando USD-cents en 0/stale.';

DROP TRIGGER IF EXISTS tg_wallet_balance_usd_sync ON public.wallet_accounts;
CREATE TRIGGER tg_wallet_balance_usd_sync
  BEFORE UPDATE OF balance, held_balance ON public.wallet_accounts
  FOR EACH ROW
  WHEN (NEW.balance IS DISTINCT FROM OLD.balance
        OR NEW.held_balance IS DISTINCT FROM OLD.held_balance)
  EXECUTE FUNCTION public.sync_wallet_balance_usd();

-- ── 2) One-time backfill: reconciliar cuentas desincronizadas ──
-- Condición: balance > 0 pero USD-cents está 0 o NULL → claramente
-- stale (la migración 00242 populó snapshot inicial; si ahora el balance
-- creció pero USD-cents quedó en 0, hubo mutations post-migración que
-- no se propagaron).
--
-- Aplica la misma fórmula que el trigger, en un solo UPDATE batch.
-- Idempotente: correr 2× no causa cambio adicional (segunda corrida
-- no encuentra filas que matcheen el WHERE).
UPDATE public.wallet_accounts wa
SET
  balance_usd_cents = ROUND(
    wa.balance * 100.0 / COALESCE(
      wa.migration_rate,
      (SELECT (value #>> '{}')::NUMERIC FROM platform_config WHERE key = 'exchange_rate_usd_cup'),
      500  -- último recurso para evitar NULL en el backfill
    )
  ),
  held_balance_usd_cents = ROUND(
    COALESCE(wa.held_balance, 0) * 100.0 / COALESCE(
      wa.migration_rate,
      (SELECT (value #>> '{}')::NUMERIC FROM platform_config WHERE key = 'exchange_rate_usd_cup'),
      500
    )
  )
WHERE wa.balance > 0
  AND (wa.balance_usd_cents IS NULL OR wa.balance_usd_cents = 0);

-- ── 3) Verificación post-migración (NO-OP info logging) ──
-- Para que ops vea en los logs cuántas cuentas se reconciliaron y
-- cuántas quedan potencialmente sospechosas (balance=0 con USD-cents>0
-- también podría ser desync, pero es ambiguo: una cuenta vacía debería
-- tener USD-cents=0, pero quizás un drift de redondeo dejó 1).
DO $$
DECLARE
  v_reconciled INTEGER;
  v_still_suspect INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_reconciled
  FROM wallet_accounts
  WHERE balance > 0 AND balance_usd_cents > 0;

  SELECT COUNT(*) INTO v_still_suspect
  FROM wallet_accounts
  WHERE balance = 0 AND COALESCE(balance_usd_cents, 0) > 0;

  RAISE NOTICE '00285: % cuentas con balance>0 ahora tienen USD-cents>0', v_reconciled;
  RAISE NOTICE '00285: % cuentas con balance=0 todavía muestran USD-cents>0 (drift menor, no crítico)', v_still_suspect;
END $$;
