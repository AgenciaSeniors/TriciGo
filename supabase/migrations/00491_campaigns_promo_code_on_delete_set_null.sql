-- 00491: allow deleting a promotion that is still referenced by a campaign.
--
-- Bug: deleting a promo from the admin panel failed with
--   'update or delete on table "promotions" violates foreign key constraint
--    "campaigns_promo_code_id_fkey" on table "campaigns"'.
-- The FK from campaigns.promo_code_id → promotions(id) (mig 00073) was created
-- without an ON DELETE action, so it defaults to NO ACTION (RESTRICT): any
-- campaign that points at a promo blocks that promo's deletion.
--
-- A campaign is a marketing record with no financial/audit value tied to the
-- promo pointer, so ON DELETE SET NULL is the correct semantics: the campaign
-- survives and simply loses its promo link when the promo is deleted.
--
-- NOTE: the other two FKs to promotions(id) are intentionally left as RESTRICT:
--   * rides.promo_code_id            (00006) — a completed ride is financial
--     history; setting it NULL would fire tg_rides_validate_promo_discount and
--     rewrite discount_amount_cup on a historical ride. A promo that was really
--     redeemed in a ride must stay undeletable (deactivate it instead).
--   * promotion_uses.promotion_id    (00006) — the per-user redemption ledger.
-- The admin UI now surfaces a friendly "already used — deactivate instead"
-- message for those RESTRICT cases.

ALTER TABLE campaigns
  DROP CONSTRAINT IF EXISTS campaigns_promo_code_id_fkey;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_promo_code_id_fkey
  FOREIGN KEY (promo_code_id) REFERENCES promotions(id) ON DELETE SET NULL;
