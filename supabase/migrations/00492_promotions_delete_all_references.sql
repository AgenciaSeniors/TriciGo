-- 00492: let a promotion be deleted even when it was already used in rides
-- or recorded in promotion_uses. Complements 00491 (campaigns SET NULL) so
-- "Eliminar" in the admin panel works for EVERY promotion, not just unused ones.
--
-- Two remaining FKs to promotions(id) were NO ACTION (RESTRICT):
--   * rides.promo_code_id            (00006)
--   * promotion_uses.promotion_id    (00006)
--
-- Decision:
--   * rides.promo_code_id           -> ON DELETE SET NULL. A ride is financial
--     history; we keep the row and just null the promo pointer. To avoid the
--     BEFORE-UPDATE trigger tg_rides_validate_promo_discount recomputing a
--     finished ride's discount to 0 when the cascade nulls promo_code_id, the
--     trigger gets a guard that preserves discount_amount_cup on terminal rides.
--   * promotion_uses.promotion_id   -> ON DELETE CASCADE. These rows exist only
--     to enforce the one-use-per-user limit (UNIQUE(promotion_id, user_id));
--     they are meaningless once the promotion is gone.

-- 1) rides.promo_code_id -> ON DELETE SET NULL
ALTER TABLE rides
  DROP CONSTRAINT IF EXISTS rides_promo_code_id_fkey;
ALTER TABLE rides
  ADD CONSTRAINT rides_promo_code_id_fkey
  FOREIGN KEY (promo_code_id) REFERENCES promotions(id) ON DELETE SET NULL;

-- 2) promotion_uses.promotion_id -> ON DELETE CASCADE
ALTER TABLE promotion_uses
  DROP CONSTRAINT IF EXISTS promotion_uses_promotion_id_fkey;
ALTER TABLE promotion_uses
  ADD CONSTRAINT promotion_uses_promotion_id_fkey
  FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE CASCADE;

-- 2b) admin_promo_audit_log.promo_code_id: DROP the FK (keep the column as a
--     soft UUID reference). This table is append-only — a trigger
--     (tg_admin_promo_audit_log_block_mutations) blocks BOTH update and delete,
--     so neither ON DELETE SET NULL nor CASCADE can run (the cascade's UPDATE/
--     DELETE is rejected and the promo delete fails). Dropping the FK lets the
--     immutable audit row survive the promo deletion while retaining the
--     historical promo_code_id it recorded.
ALTER TABLE admin_promo_audit_log
  DROP CONSTRAINT IF EXISTS admin_promo_audit_log_promo_code_id_fkey;

-- 3) Guard the promo-discount trigger so the ON DELETE SET NULL cascade does
--    NOT rewrite a finished ride's historical discount. Patched in-place from
--    the LIVE body (never a verbatim rewrite) so no other logic can be lost.
DO $patch$
DECLARE
  v_src    text;
  v_anchor text := $g$BEGIN
  v_fare_base := COALESCE($g$;
  v_guard  text := $g$BEGIN
  -- 00492: deleting a promotion cascades ON DELETE SET NULL onto
  -- rides.promo_code_id. On an already-finished ride, preserve the historical
  -- discount instead of recomputing it to 0 (promo deleted via ON DELETE SET NULL).
  IF TG_OP = 'UPDATE'
     AND OLD.promo_code_id IS NOT NULL
     AND NEW.promo_code_id IS NULL
     AND NEW.status IN ('completed', 'cancelled') THEN
    RETURN NEW;
  END IF;

  v_fare_base := COALESCE($g$;
BEGIN
  SELECT pg_get_functiondef('public.tg_rides_validate_promo_discount()'::regprocedure)
    INTO v_src;

  IF v_src IS NULL THEN
    RAISE NOTICE '00492: tg_rides_validate_promo_discount absent; skipping guard';
  ELSIF position('promo deleted via ON DELETE SET NULL' IN v_src) > 0 THEN
    RAISE NOTICE '00492: promo-delete guard already present; skipping';
  ELSIF position(v_anchor IN v_src) = 0 THEN
    RAISE EXCEPTION '00492: anchor not found in tg_rides_validate_promo_discount; aborting patch';
  ELSE
    EXECUTE replace(v_src, v_anchor, v_guard);
    RAISE NOTICE '00492: patched tg_rides_validate_promo_discount with promo-delete guard';
  END IF;
END $patch$;
