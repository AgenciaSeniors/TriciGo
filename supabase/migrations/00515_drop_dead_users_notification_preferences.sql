-- ============================================================
-- 00515 — Drop the dead `users.notification_preferences` column
--
-- There are two things with this name:
--
--   * the TABLE `public.notification_preferences` — real, one row per
--     user, five boolean columns, written by the client / driver / web
--     settings screens and (since the 2026-07 audit) read by `send-push`;
--   * the COLUMN `public.users.notification_preferences` (jsonb) — a
--     leftover duplicate that has never held a value.
--
-- Measured before writing this migration: 167 user rows, ZERO with
-- anything other than the `{}` default. A repo-wide grep finds no code
-- reading or writing the column — the only hits are comments referring
-- to the table.
--
-- It is dropped because an empty duplicate of a real feature is a trap:
-- the obvious next step for someone wiring up notification settings is
-- to write to the column on `users` they can already see, which would
-- silently do nothing. That is precisely the class of bug the audit this
-- came from spent its time removing.
--
-- DEFENSIVE: the drop only runs if the column is still unused at apply
-- time. If anything started writing to it in the meantime, the migration
-- leaves it alone and warns instead of destroying data.
-- ============================================================

DO $$
DECLARE
  v_exists  BOOLEAN;
  v_in_use  BIGINT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'users'
      AND column_name  = 'notification_preferences'
  ) INTO v_exists;

  IF NOT v_exists THEN
    RAISE NOTICE '00515: users.notification_preferences already absent; nothing to do';
    RETURN;
  END IF;

  EXECUTE $q$
    SELECT count(*) FROM users
    WHERE notification_preferences IS NOT NULL
      AND notification_preferences <> '{}'::jsonb
  $q$ INTO v_in_use;

  IF v_in_use > 0 THEN
    RAISE WARNING
      '00515: SKIPPED — users.notification_preferences holds data in % row(s). '
      'Something started using it after this migration was written. '
      'Investigate before dropping.', v_in_use;
    RETURN;
  END IF;

  ALTER TABLE public.users DROP COLUMN notification_preferences;
  RAISE NOTICE '00515: dropped dead column users.notification_preferences';
END $$;

COMMENT ON TABLE public.notification_preferences IS
  'Per-user notification category switches (ride_updates, chat_messages, '
  'payment_updates, promotions, driver_approval). THE source of truth — '
  'written by the settings screens and read by the send-push edge function. '
  'A duplicate jsonb column on `users` was dropped in 00515; do not '
  'reintroduce one.';
