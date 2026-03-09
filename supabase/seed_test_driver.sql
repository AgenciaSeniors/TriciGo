-- ============================================================
-- SEED: Test driver profile for phone 5359876543
-- ============================================================
-- PREREQUISITE: The driver must first log in via the driver app
-- using OTP (5359876543 / 123456) so that auth.users and
-- public.users rows exist.
--
-- Run this in the Supabase SQL Editor after the first login.
-- ============================================================

DO $$
DECLARE
  v_user_id UUID;
  v_driver_id UUID;
BEGIN
  -- 1. Find the user by phone
  SELECT id INTO v_user_id
  FROM public.users
  WHERE phone = '5359876543';

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User with phone 5359876543 not found. Log in first via the driver app.';
  END IF;

  -- 2. Update user role to driver and set name
  UPDATE public.users
  SET
    full_name = 'Carlos Test Driver',
    role = 'driver',
    updated_at = NOW()
  WHERE id = v_user_id;

  -- 3. Create driver_profile (approved)
  INSERT INTO public.driver_profiles (user_id, status, rating_avg, approved_at)
  VALUES (v_user_id, 'approved', 4.85, NOW())
  ON CONFLICT (user_id) DO UPDATE SET
    status = 'approved',
    approved_at = NOW(),
    updated_at = NOW()
  RETURNING id INTO v_driver_id;

  -- 4. Create vehicle (triciclo)
  INSERT INTO public.vehicles (driver_id, type, make, model, year, color, plate_number, capacity)
  VALUES (v_driver_id, 'triciclo', 'Custom', 'Triciclo Electrico', 2023, 'Azul', 'HAB-1234', 2)
  ON CONFLICT DO NOTHING;

  -- 5. Create wallet account for driver
  INSERT INTO public.wallet_accounts (user_id, account_type, balance, currency)
  VALUES (v_user_id, 'driver_cash', 0, 'TRC')
  ON CONFLICT (user_id, account_type) DO NOTHING;

  RAISE NOTICE 'Test driver created successfully! user_id=%, driver_id=%', v_user_id, v_driver_id;
END $$;
