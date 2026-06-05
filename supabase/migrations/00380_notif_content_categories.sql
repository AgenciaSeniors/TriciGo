-- ============================================================
-- 00380_notif_content_categories.sql
--
-- Adds the admin-content notification categories to the
-- `notifications.type` CHECK (added by 00333) and, in the same PR,
-- to the send-push EF `VALID_CATEGORIES` validator.
--
-- WHY: `broadcastToActiveUsers()` (the "Notificar ahora" buttons on
-- the admin announcement/blog pages, and the upcoming notify-on-
-- publish + promotions flows) forwards `contentType` verbatim as the
-- push `category` — 'announcement' | 'blog' | 'campaign'. None of
-- those were in the 00333 CHECK nor in send-push's whitelist, so the
-- EF returned 400 invalid_category and the content push silently
-- failed. This unblocks it.
--
-- New values:
--   announcement   home_announcements push
--   blog           blog_posts push
--   news           reserved alias for blog/news content
--   campaign       broadcastToActiveUsers contentType union member
--
-- 'promo' is already whitelisted (used by the promotions flow).
--
-- Idempotent: DROP IF EXISTS + re-ADD (same pattern as 00333).
-- NOT VALID + VALIDATE keeps existing rows from blocking the ALTER;
-- every current value is a subset of the new list, so VALIDATE passes.
-- ============================================================

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'ride',
    'ride_offer',
    'ride_matching',
    'chat',
    'proximity',
    'payment',
    'wallet_recharge',
    'wallet_recharge_refund',
    'wallet_credit',
    'wallet_debit',
    'scheduled_ride',
    'lost_item',
    'dispute_update',
    'sos',
    'delivery',
    'system',
    'promo',
    -- Admin content notifications (00380)
    'announcement',
    'blog',
    'news',
    'campaign',
    -- Legacy values — see 00333 header. Backward-compat only.
    'ride_updates',
    'wallet_v2_migration'
  ))
  NOT VALID;

ALTER TABLE notifications
  VALIDATE CONSTRAINT notifications_type_check;

COMMENT ON CONSTRAINT notifications_type_check ON notifications IS
  '00380 (extends 00333): Curated discriminator for inbox routing. Keep in sync with send-push EF VALID_CATEGORIES. 00380 adds announcement/blog/news/campaign for admin content push.';
