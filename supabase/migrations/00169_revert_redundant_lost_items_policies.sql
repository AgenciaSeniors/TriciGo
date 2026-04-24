-- ============================================================
-- BUG-112 RETRACTION: my audit incorrectly concluded that lost_items
-- had RLS enabled with zero policies. The truth was that my initial
-- sweep filter looked for `users.role` patterns and missed policies
-- that use the is_admin() helper or direct auth.uid() comparisons.
--
-- Migration 00168 added 4 redundant policies:
--   - lost_items_reporter_all (superset of existing lost_items_insert
--     + lost_items_select + lost_items_update for the reporter)
--   - lost_items_driver_read / lost_items_driver_update (added a
--     driver_profiles JOIN, but the existing lost_items_select and
--     lost_items_update already cover driver_id = auth.uid() — and
--     lost_items.driver_id is a FK to auth.users(id), not
--     driver_profiles.id, so the JOIN isn't even needed)
--   - lost_items_admin_all (duplicate of li_admin_select + li_admin_update)
--
-- RLS policies OR together so these additions don't CHANGE access,
-- but they add noise. This migration removes them to keep the schema
-- clean. No functional change.
-- ============================================================

DROP POLICY IF EXISTS lost_items_reporter_all ON public.lost_items;
DROP POLICY IF EXISTS lost_items_driver_read ON public.lost_items;
DROP POLICY IF EXISTS lost_items_driver_update ON public.lost_items;
DROP POLICY IF EXISTS lost_items_admin_all ON public.lost_items;
