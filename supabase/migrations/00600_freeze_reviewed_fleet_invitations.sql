-- ============================================================
-- 00600: a reviewed fleet invitation stays as the admin reviewed it
--
-- A fleet owner can rewrite an invitation (fleet_members) after the admin has
-- reviewed it. The owner's UPDATE policy, fleet_members_owner_or_admin_update,
-- has no WITH CHECK; `authenticated` can UPDATE every column; and
-- tg_fleet_members_protect() only reverts status, driver_id, signed_up_at,
-- reviewed_at and reviewed_by for the owner. The number, the name, the email,
-- the licence, the ID, the licence document, the fleet and the admin's
-- rejection reason all stay writable. Every path that links an invitation to
-- an account (auto_link_fleet_member_on_signup, the admin relink RPC, and the
-- 00598 triggers and backfill) reads an approved, unlinked row as "the admin
-- approved this person at this number". So an owner can point an approved
-- invitation at someone else's number. When that person signs up, or has the
-- number confirmed later (00598), they are linked to the fleet under a name
-- and licence the admin never saw, and nobody reviewed them. Moving the row
-- to another fleet of the same owner carries the approval with it.
-- Reproduced locally with the live bodies and RLS on. fleet_members,
-- driver_fleets and corporate_accounts had 0 rows in prod on 2026-09-25, so
-- nobody was hit.
--
-- Owner decisions (2026-09-25):
--   * Freeze, silently, the way the trigger already treats status: the
--     owner's write succeeds and the reviewed values stay. To change a
--     reviewed member, the owner deletes the row and invites again, and the
--     new row goes to review.
--   * Once the invitation has left 'pending_review', the owner can no longer
--     change what the admin reviewed (driver_phone, driver_name, driver_email,
--     driver_license_number, driver_id_number, license_doc_path) or the fleet
--     it was reviewed for (fleet_id). rejected_reason is the admin's text, so
--     the owner cannot change it in any status (the INSERT branch already
--     clears it).
--
-- Fix: tg_fleet_members_protect() is transcribed from the live body (md5
-- 8b0d07af..., 674 chars, no comments; the 00435 file in git has the same
-- logic with comments) and gains one block at the end of the owner's UPDATE
-- branch. Only the owner's path changes. Admins, callers with no JWT (the
-- service role, migrations, GoTrue) and the writers that set
-- app.trusted_fleet_update (the signup link, the relink RPC and 00598's
-- confirmation link) return before that block, and none of them writes these
-- columns. 00598's approval trigger is a separate trigger that fires after
-- this one, on the admin's approval. The trigger itself (name, timing,
-- events) and the function's ACL are untouched, so that order stays.
--
-- The migration refuses to replace a body it was not written against: if
-- someone changed the function after 2026-09-25, replacing it would silently
-- drop that change. It also asserts its own result instead of trusting
-- CREATE, since plpgsql only checks a body when it runs: after checking that
-- the trigger is still attached as before, a rolled-back self-test acts as a
-- real non-admin account.
--
-- Not covered here, flagged separately: an owner edit while the invitation
-- is still in review, between the admin opening it and approving it; the
-- licence file itself, which the storage-upload function lets the owner
-- overwrite under the same path; and moving a whole fleet to another company
-- of the same owner (driver_fleets.corporate_account_id), which carries every
-- reviewed member with it.
-- Rehearsal: supabase/tests/00600/run.sh.
-- ============================================================

SET lock_timeout = '5s';

-- 1. Only replace a body this migration knows ---------------------------------
DO $$
DECLARE
  v_fn  regprocedure := to_regprocedure('public.tg_fleet_members_protect()');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION '00600: public.tg_fleet_members_protect() does not exist (00435 creates it)';
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
  -- The live body on 2026-09-25, 00435's text in git (a database built from
  -- the migrations), or the body below (this migration already ran).
  IF v_md5 NOT IN ('8b0d07aff7ab33142bfcec29304c01ed',
                   '9d34552cc0598d60952239a2680129fd',
                   '2b65b4b84e3a2ce323197501e5742c1a') THEN
    RAISE EXCEPTION '00600: tg_fleet_members_protect() is not the body this migration was written against (md5 %). Transcribe it again from pg_get_functiondef and keep what changed.', v_md5;
  END IF;
END $$;

-- 2. The owner's UPDATE keeps what the admin reviewed ------------------------------
CREATE OR REPLACE FUNCTION public.tg_fleet_members_protect()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_fleet_update', true) = '1' THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status          := 'pending_review';
    NEW.driver_id       := NULL;
    NEW.signed_up_at    := NULL;
    NEW.reviewed_at     := NULL;
    NEW.reviewed_by     := NULL;
    NEW.rejected_reason := NULL;
    RETURN NEW;
  ELSE
    NEW.status       := OLD.status;
    NEW.driver_id    := OLD.driver_id;
    NEW.signed_up_at := OLD.signed_up_at;
    NEW.reviewed_at  := OLD.reviewed_at;
    NEW.reviewed_by  := OLD.reviewed_by;
    -- 00600: the rejection reason is the admin's text. Once the admin has
    -- reviewed the invitation, what they reviewed and the fleet it is for
    -- stay as reviewed; to change them, the owner deletes it and invites again.
    NEW.rejected_reason := OLD.rejected_reason;
    IF OLD.status IS DISTINCT FROM 'pending_review' THEN
      NEW.fleet_id              := OLD.fleet_id;
      NEW.driver_name           := OLD.driver_name;
      NEW.driver_phone          := OLD.driver_phone;
      NEW.driver_email          := OLD.driver_email;
      NEW.driver_license_number := OLD.driver_license_number;
      NEW.driver_id_number      := OLD.driver_id_number;
      NEW.license_doc_path      := OLD.license_doc_path;
    END IF;
    RETURN NEW;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.tg_fleet_members_protect() IS
  'BEFORE INSERT OR UPDATE on fleet_members. For the fleet owner (a JWT that is not an admin, without app.trusted_fleet_update), an insert always starts in pending_review, unlinked and unreviewed. An update never changes status, driver_id, signed_up_at, reviewed_at, reviewed_by or rejected_reason, and once the invitation has left pending_review it does not change the reviewed fields (driver_phone, driver_name, driver_email, driver_license_number, driver_id_number, license_doc_path) or fleet_id either (00600). The owner''s write succeeds with those values kept; to change a reviewed member, delete it and invite again.';

-- 3. Assert the result ---------------------------------------------------------------
-- First, the trigger must still be attached as before; without it nothing
-- below holds. Then, acting as a real non-admin account (its id in the JWT
-- claims, the way PostgREST sets them), the block rewrites an approved
-- invitation (all seven reviewed fields), rewrites an admin's rejection
-- reason and edits an invitation still in review. Each write must hit its
-- row; the first two must be kept and the third must go through. Everything
-- the block does is rolled back, the claims included. A database with no
-- non-admin account has nobody to act as, so the behaviour check is skipped
-- there.
DO $$
DECLARE
  v_owner          uuid;
  v_claim_sub      text := current_setting('request.jwt.claim.sub', true);
  v_claims         text := current_setting('request.jwt.claims', true);
  v_corp_a         uuid := gen_random_uuid();
  v_corp_b         uuid := gen_random_uuid();
  v_fleet_a        uuid := gen_random_uuid();
  v_fleet_b        uuid := gen_random_uuid();
  v_reviewed       uuid := gen_random_uuid();
  v_rejected       uuid := gen_random_uuid();
  v_pending        uuid := gen_random_uuid();
  v_rows           integer;
  v_after_reviewed text;
  v_after_rejected text;
  v_after_pending  text;
  v_expected       text := concat_ws('|', 'fleet a', 'Reviewed', '+5355500601', 'reviewed@00600.test', 'L-1', 'I-1', 'doc-1');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.fleet_members'::regclass
      AND t.tgname = 'trg_fleet_members_protect'
      AND t.tgfoid = 'public.tg_fleet_members_protect()'::regprocedure
      AND t.tgtype = 23                        -- FOR EACH ROW | BEFORE | INSERT | UPDATE
      AND t.tgenabled = 'O'
      AND cardinality(t.tgattr::int2[]) = 0    -- every column, not UPDATE OF
  ) THEN
    RAISE EXCEPTION '00600: trg_fleet_members_protect is not attached to fleet_members as an enabled BEFORE INSERT OR UPDATE FOR EACH ROW trigger';
  END IF;

  SELECT u.id INTO v_owner
  FROM public.users u
  WHERE u.role NOT IN ('admin', 'super_admin')
  ORDER BY u.created_at, u.id
  LIMIT 1;

  IF v_owner IS NULL THEN
    RAISE NOTICE '00600: no non-admin account yet, behaviour self-test skipped';
    RETURN;
  END IF;

  BEGIN
    -- Fixtures, written with no JWT, so the trigger lets them through as they are.
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('app.trusted_fleet_update', '', true);
    INSERT INTO public.corporate_accounts (id, name, contact_phone, created_by) VALUES
      (v_corp_a, '00600 self-test A', '+5355500600', v_owner),
      (v_corp_b, '00600 self-test B', '+5355500600', v_owner);
    INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES
      (v_fleet_a, v_corp_a, '00600 self-test A'),
      (v_fleet_b, v_corp_b, '00600 self-test B');
    INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone, driver_email,
                                      driver_license_number, driver_id_number, license_doc_path,
                                      status, rejected_reason) VALUES
      (v_reviewed, v_fleet_a, 'Reviewed', '+5355500601', 'reviewed@00600.test', 'L-1', 'I-1', 'doc-1', 'approved', NULL),
      (v_rejected, v_fleet_a, 'Rejected', '+5355500602', NULL, NULL, NULL, NULL, 'rejected', 'admin reason'),
      (v_pending,  v_fleet_a, 'Pending',  '+5355500603', NULL, NULL, NULL, NULL, 'pending_review', NULL);

    -- The owner's writes, with the owner's id in the JWT claims.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    UPDATE public.fleet_members
       SET fleet_id = v_fleet_b, driver_name = 'Other', driver_phone = '+5355500699',
           driver_email = 'other@00600.test', driver_license_number = 'L-9',
           driver_id_number = 'I-9', license_doc_path = 'doc-9'
     WHERE id = v_reviewed;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION '00600: the self-test rewrite of the approved invitation hit % rows', v_rows;
    END IF;
    UPDATE public.fleet_members SET rejected_reason = 'owner text' WHERE id = v_rejected;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION '00600: the self-test rewrite of the rejection reason hit % rows', v_rows;
    END IF;
    UPDATE public.fleet_members SET driver_phone = '+5355500698' WHERE id = v_pending;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION '00600: the self-test edit of the invitation in review hit % rows', v_rows;
    END IF;
    PERFORM set_config('request.jwt.claims', '', true);

    SELECT concat_ws('|', CASE fleet_id WHEN v_fleet_a THEN 'fleet a' WHEN v_fleet_b THEN 'fleet b' END,
                     driver_name, driver_phone, driver_email, driver_license_number, driver_id_number, license_doc_path)
      INTO v_after_reviewed FROM public.fleet_members WHERE id = v_reviewed;
    SELECT rejected_reason INTO v_after_rejected FROM public.fleet_members WHERE id = v_rejected;
    SELECT driver_phone INTO v_after_pending FROM public.fleet_members WHERE id = v_pending;

    RAISE EXCEPTION '00600 self-test rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> '00600 self-test rollback' THEN
      RAISE;
    END IF;
  END;

  IF v_after_reviewed IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION '00600: the owner changed an invitation the admin had reviewed: % (expected %)', coalesce(v_after_reviewed, 'missing'), v_expected;
  END IF;
  IF v_after_rejected IS DISTINCT FROM 'admin reason' THEN
    RAISE EXCEPTION '00600: the owner rewrote the admin''s rejection reason: %', coalesce(v_after_rejected, 'NULL');
  END IF;
  IF v_after_pending IS DISTINCT FROM '+5355500698' THEN
    RAISE EXCEPTION '00600: the owner could not edit an invitation still in review: %', coalesce(v_after_pending, 'missing');
  END IF;
  IF coalesce(current_setting('request.jwt.claim.sub', true), '') <> coalesce(v_claim_sub, '')
     OR coalesce(current_setting('request.jwt.claims', true), '') <> coalesce(v_claims, '') THEN
    RAISE EXCEPTION '00600: the self-test left a JWT claim set';
  END IF;
  RAISE NOTICE '00600: verified, the owner cannot change a reviewed invitation and can still edit one in review';
END $$;

RESET lock_timeout;
