-- ============================================================
-- 00614 — fare split: the invitee can decline their invite
--
-- WHY
--   The "Rechazar" button of a split invite (rider app SplitInviteCard, web
--   SplitInviteBanner) deletes the invitee's ride_splits row. The only DELETE
--   policy, split_delete, lets the ride's requester withdraw an invite, not
--   the invitee decline it: the DELETE matched 0 rows, PostgREST answered OK,
--   the card disappeared, and the invite came back on the next poll or app
--   start. Nothing was ever declined.
--
-- WHAT
--   split_delete_invitee: a signed-in user may delete their own invite while
--   it is unanswered and unpaid (accepted_at, paid_at NULL, payment_status
--   'pending'). An accepted invite stays: complete_ride_and_pay charges it,
--   and the invitee already agreed to pay. Declining moves no money:
--   complete_ride_and_pay only charges accepted splits, and the requester
--   pays the rest of the fare, including the declined part. No other share
--   goes up (00613 never raises a share).
--   Old app builds work as soon as this is applied: they already send this
--   DELETE. Their follow-up "no splits left → is_split = false" on rides is a
--   no-op for the invitee (r_update only lets the customer, the driver or an
--   admin update a ride), as it was before.
--
-- Adds a policy, drops nothing. If a policy with this name already exists the
-- migration checks it instead of replacing it, and aborts if it differs.
-- ============================================================

DO $policy$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                 WHERE polrelid = 'public.ride_splits'::regclass
                   AND polname = 'split_delete_invitee') THEN
    CREATE POLICY split_delete_invitee ON public.ride_splits
      AS PERMISSIVE FOR DELETE TO authenticated
      USING (user_id = (SELECT auth.uid())
             AND accepted_at IS NULL
             AND paid_at IS NULL
             AND payment_status = 'pending');
  END IF;
END
$policy$;

COMMENT ON POLICY split_delete_invitee ON public.ride_splits IS
  '00614: the invitee may decline (delete) their own split invite while it is unanswered and unpaid.';

-- Assert the end state, whatever created the policy.
DO $check$
DECLARE
  v_qual text;
BEGIN
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO v_qual
  FROM pg_policy p
  WHERE p.polrelid = 'public.ride_splits'::regclass
    AND p.polname = 'split_delete_invitee'
    AND p.polcmd = 'd'
    AND p.polpermissive
    AND p.polroles = ARRAY['authenticated'::regrole]::oid[]
    AND p.polwithcheck IS NULL;
  IF v_qual IS NULL THEN
    RAISE EXCEPTION '00614: split_delete_invitee is missing or not a permissive DELETE policy for authenticated';
  END IF;
  IF position('user_id = ( SELECT auth.uid() AS uid)' IN v_qual) = 0
     OR position('accepted_at IS NULL' IN v_qual) = 0
     OR position('paid_at IS NULL' IN v_qual) = 0
     OR position('payment_status = ''pending''' IN v_qual) = 0
     OR position(' OR ' IN v_qual) > 0 THEN
    RAISE EXCEPTION '00614: split_delete_invitee has an unexpected condition: %', v_qual;
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ride_splits'::regclass) THEN
    RAISE EXCEPTION '00614: row level security is off on ride_splits';
  END IF;
END
$check$;
