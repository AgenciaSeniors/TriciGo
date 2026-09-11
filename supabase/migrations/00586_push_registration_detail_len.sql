-- 00586: let `push_registration_status.detail` hold a whole error, not its first sentence.
--
-- WHY
-- 00585 capped `detail` at 300 characters on the reasoning that it "carries an
-- error message, never a payload". The first `error` row the table ever
-- recorded proved the cap too tight to diagnose with:
--
--   Error encountered while fetching Expo token, expected an OK response,
--   received: 403 (body: "<html>… <h1>Error: Forbidden</h1><h2>Your client does not hav
--                                                                                    ^ cut
--
-- That is a Google Cloud edge denial page in front of `exp.host`, seen from a
-- Cuban IP — a failure mode no hypothesis had listed, and the 300 cut away
-- exactly the part that identified it. The diagnosis had to be rebuilt by
-- reading the installed expo-notifications source instead.
--
-- 2000 keeps a full denial page. The table is one row per (user_id, app), so
-- the storage cost is irrelevant next to the evidence.
--
-- KEEP IN SYNC: `PUSH_DETAIL_MAX_LEN` in packages/utils/src/pushRegistration.ts
-- is the app-side cut and MUST equal this number. If the app ever sends more
-- than this CHECK allows, the upsert fails and recordPushRegistration logs and
-- swallows it — the row is lost ENTIRELY, which is strictly worse than the
-- truncation the cap exists to avoid.
--
-- Editing 00585 in place would NOT have worked: its constraint is created
-- under `IF NOT EXISTS`, so on an already-migrated database it is a no-op.

DO $constraints$
BEGIN
  -- Unconditional drop-then-add so re-running this file is idempotent.
  -- No existing row can violate the wider bound: every value written so far
  -- was already cut at 300 by the app.
  ALTER TABLE public.push_registration_status
    DROP CONSTRAINT IF EXISTS push_registration_status_detail_len;

  ALTER TABLE public.push_registration_status
    ADD CONSTRAINT push_registration_status_detail_len
    CHECK (detail IS NULL OR length(detail) <= 2000);
END $constraints$;

COMMENT ON COLUMN public.push_registration_status.detail IS
  '00586: full error text for outcome=error (<=2000, matches PUSH_DETAIL_MAX_LEN in packages/utils). Raised from 300, which cut the Google Cloud 403 page from exp.host mid-sentence.';
