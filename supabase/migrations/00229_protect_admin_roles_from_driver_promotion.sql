-- ============================================================
-- BUG-213 critical follow-up to 00227:
-- 00227 Part A's UPDATE users.role unconditionally demoted any
-- approved driver with role <> 'driver' to role='driver'. This
-- included super_admins/admins who had created an approved
-- driver profile for self-testing — specifically
-- edua56621636@gmail.com (super_admin, the user testing). After
-- the demotion they lost access to /admin and is_admin()-gated
-- RPCs.
--
-- Two fixes:
--   1) Restore the affected super_admin role (Eduardo's account).
--      We hardcode the ID since it's the only user impacted in
--      production by 00227 Part A.
--   2) Patch the trigger ensure_driver_role_and_tricicoin_on_approval
--      so it NEVER overwrites admin/super_admin roles. The
--      effective_role logic in 00143 handles their dual role
--      (admin + driver) for ride transitions.
-- ============================================================

UPDATE users
SET role = 'super_admin'
WHERE id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  AND role = 'driver';

CREATE OR REPLACE FUNCTION ensure_driver_role_and_tricicoin_on_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.status = 'approved'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN
    -- Promote ONLY plain customers; leave admin/super_admin alone.
    -- Their elevated role takes precedence over the driver flag —
    -- the effective_role logic in 00143 already treats them as
    -- driver for ride transitions when they own the driver_profile.
    UPDATE users
       SET role = 'driver'
     WHERE id = NEW.user_id
       AND role NOT IN ('driver', 'admin', 'super_admin');

    -- Wallet provisioning is safe for any role (admins testing
    -- as drivers still need a tricicoin wallet to accept rides).
    INSERT INTO wallet_accounts (user_id, account_type, balance)
    VALUES (NEW.user_id, 'tricicoin'::wallet_account_type, 0)
    ON CONFLICT (user_id, account_type) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION ensure_driver_role_and_tricicoin_on_approval() IS
  'BUG-213 (00227) + admin-protection (00229): on driver approval, '
  'promote plain customers to role=driver and ensure tricicoin '
  'wallet exists. Admin/super_admin roles are preserved; the '
  'effective_role logic in 00143 handles their dual role for ride '
  'transitions.';
