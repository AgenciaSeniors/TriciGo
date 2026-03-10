-- ============================================================
-- TriciGo — Development Seed Data
-- Creates test users, drivers, vehicles, wallet accounts,
-- sample rides, support tickets, and referrals.
--
-- Prerequisites:
--   1. Run seed.sql first (service types, zones, pricing rules)
--   2. Test users must exist in auth.users via OTP login:
--      Customers: 5351111111, 5352222222, 5353333333
--      Drivers:   5354444444, 5355555555, 5356666666
-- ============================================================

DO $$
DECLARE
  v_cust1 UUID; v_cust2 UUID; v_cust3 UUID;
  v_drv1 UUID; v_drv2 UUID; v_drv3 UUID;
  v_dp1 UUID; v_dp2 UUID; v_dp3 UUID;
  v_ride1 UUID;
  v_ticket1 UUID;
BEGIN
  -- ========== FIND TEST USERS ==========
  SELECT id INTO v_cust1 FROM users WHERE phone LIKE '%5351111111';
  SELECT id INTO v_cust2 FROM users WHERE phone LIKE '%5352222222';
  SELECT id INTO v_cust3 FROM users WHERE phone LIKE '%5353333333';
  SELECT id INTO v_drv1 FROM users WHERE phone LIKE '%5354444444';
  SELECT id INTO v_drv2 FROM users WHERE phone LIKE '%5355555555';
  SELECT id INTO v_drv3 FROM users WHERE phone LIKE '%5356666666';

  -- Abort if no test users found
  IF v_cust1 IS NULL AND v_drv1 IS NULL THEN
    RAISE NOTICE 'No test users found. Login with test phone numbers first.';
    RETURN;
  END IF;

  -- ========== CUSTOMER PROFILES ==========
  IF v_cust1 IS NOT NULL THEN
    UPDATE users SET full_name = 'Ana Test Customer', role = 'customer' WHERE id = v_cust1;
  END IF;
  IF v_cust2 IS NOT NULL THEN
    UPDATE users SET full_name = 'Beto Test Customer', role = 'customer' WHERE id = v_cust2;
  END IF;
  IF v_cust3 IS NOT NULL THEN
    UPDATE users SET full_name = 'Carmen Test Customer', role = 'customer' WHERE id = v_cust3;
  END IF;

  -- Ensure customer profiles exist
  IF v_cust1 IS NOT NULL THEN
    INSERT INTO customer_profiles (user_id) VALUES (v_cust1) ON CONFLICT (user_id) DO NOTHING;
  END IF;
  IF v_cust2 IS NOT NULL THEN
    INSERT INTO customer_profiles (user_id) VALUES (v_cust2) ON CONFLICT (user_id) DO NOTHING;
  END IF;
  IF v_cust3 IS NOT NULL THEN
    INSERT INTO customer_profiles (user_id) VALUES (v_cust3) ON CONFLICT (user_id) DO NOTHING;
  END IF;

  -- ========== DRIVER PROFILES ==========
  IF v_drv1 IS NOT NULL THEN
    UPDATE users SET full_name = 'Diego Test Driver', role = 'driver' WHERE id = v_drv1;
    INSERT INTO driver_profiles (user_id, status, rating_avg, total_trips, approved_at)
    VALUES (v_drv1, 'approved', 4.85, 47, NOW() - INTERVAL '30 days')
    ON CONFLICT (user_id) DO UPDATE SET status = 'approved', rating_avg = 4.85
    RETURNING id INTO v_dp1;
  END IF;

  IF v_drv2 IS NOT NULL THEN
    UPDATE users SET full_name = 'Elena Test Driver', role = 'driver' WHERE id = v_drv2;
    INSERT INTO driver_profiles (user_id, status, rating_avg, total_trips, approved_at)
    VALUES (v_drv2, 'approved', 4.60, 23, NOW() - INTERVAL '15 days')
    ON CONFLICT (user_id) DO UPDATE SET status = 'approved', rating_avg = 4.60
    RETURNING id INTO v_dp2;
  END IF;

  IF v_drv3 IS NOT NULL THEN
    UPDATE users SET full_name = 'Felix Test Driver', role = 'driver' WHERE id = v_drv3;
    INSERT INTO driver_profiles (user_id, status, rating_avg, total_trips, approved_at)
    VALUES (v_drv3, 'approved', 4.92, 89, NOW() - INTERVAL '60 days')
    ON CONFLICT (user_id) DO UPDATE SET status = 'approved', rating_avg = 4.92
    RETURNING id INTO v_dp3;
  END IF;

  -- ========== VEHICLES ==========
  IF v_dp1 IS NOT NULL THEN
    INSERT INTO vehicles (driver_id, type, make, model, year, color, plate_number, capacity)
    VALUES (v_dp1, 'triciclo', 'Custom', 'Triciclo Eléctrico', 2023, 'Azul', 'HAB-DEV1', 2)
    ON CONFLICT DO NOTHING;
  END IF;

  IF v_dp2 IS NOT NULL THEN
    INSERT INTO vehicles (driver_id, type, make, model, year, color, plate_number, capacity)
    VALUES (v_dp2, 'moto', 'Honda', 'CB150', 2022, 'Negro', 'HAB-DEV2', 1)
    ON CONFLICT DO NOTHING;
  END IF;

  IF v_dp3 IS NOT NULL THEN
    INSERT INTO vehicles (driver_id, type, make, model, year, color, plate_number, capacity)
    VALUES (v_dp3, 'auto', 'Geely', 'EC7', 2021, 'Blanco', 'HAB-DEV3', 4)
    ON CONFLICT DO NOTHING;
  END IF;

  -- ========== WALLET ACCOUNTS ==========
  -- Customers get 500 TC (50000 centavos) each
  IF v_cust1 IS NOT NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, currency, is_active)
    VALUES (v_cust1, 'customer_cash', 50000, 'TRC', true)
    ON CONFLICT (user_id, account_type) DO UPDATE SET balance = 50000;
  END IF;
  IF v_cust2 IS NOT NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, currency, is_active)
    VALUES (v_cust2, 'customer_cash', 50000, 'TRC', true)
    ON CONFLICT (user_id, account_type) DO UPDATE SET balance = 50000;
  END IF;
  IF v_cust3 IS NOT NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, currency, is_active)
    VALUES (v_cust3, 'customer_cash', 50000, 'TRC', true)
    ON CONFLICT (user_id, account_type) DO UPDATE SET balance = 50000;
  END IF;

  -- Drivers get 200 TC (20000 centavos) each
  IF v_drv1 IS NOT NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, currency, is_active)
    VALUES (v_drv1, 'driver_cash', 20000, 'TRC', true)
    ON CONFLICT (user_id, account_type) DO UPDATE SET balance = 20000;
  END IF;
  IF v_drv2 IS NOT NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, currency, is_active)
    VALUES (v_drv2, 'driver_cash', 20000, 'TRC', true)
    ON CONFLICT (user_id, account_type) DO UPDATE SET balance = 20000;
  END IF;
  IF v_drv3 IS NOT NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, currency, is_active)
    VALUES (v_drv3, 'driver_cash', 20000, 'TRC', true)
    ON CONFLICT (user_id, account_type) DO UPDATE SET balance = 20000;
  END IF;

  -- ========== SAMPLE COMPLETED RIDE ==========
  IF v_cust1 IS NOT NULL AND v_dp1 IS NOT NULL THEN
    v_ride1 := gen_random_uuid();
    INSERT INTO rides (
      id, customer_id, driver_id, service_type,
      pickup_address, pickup_location,
      dropoff_address, dropoff_location,
      status, payment_method,
      estimated_fare_cup, final_fare_cup,
      estimated_distance_m, actual_distance_m,
      estimated_duration_s, actual_duration_s,
      created_at, accepted_at, completed_at
    ) VALUES (
      v_ride1, v_cust1, v_dp1, 'triciclo_basico',
      'Capitolio Nacional, Habana',
      ST_SetSRID(ST_MakePoint(-82.3599, 23.1352), 4326),
      'Hotel Nacional, Vedado',
      ST_SetSRID(ST_MakePoint(-82.3964, 23.1375), 4326),
      'completed', 'cash',
      5000, 4800,
      3500, 3200,
      600, 540,
      NOW() - INTERVAL '2 hours',
      NOW() - INTERVAL '2 hours' + INTERVAL '3 minutes',
      NOW() - INTERVAL '1 hour'
    ) ON CONFLICT DO NOTHING;

    -- ========== SAMPLE SUPPORT TICKET ==========
    INSERT INTO support_tickets (user_id, ride_id, category, subject, description, status)
    VALUES (
      v_cust1, v_ride1, 'ride_issue',
      'Cobro incorrecto en viaje',
      'El conductor me cobró más de lo que decía la app. La tarifa estimada era $50 pero me cobró $60.',
      'open'
    ) ON CONFLICT DO NOTHING;
  END IF;

  -- ========== SAMPLE REFERRAL ==========
  IF v_cust1 IS NOT NULL AND v_cust2 IS NOT NULL THEN
    INSERT INTO referrals (referrer_id, referee_id, code, status, bonus_amount)
    VALUES (
      v_cust1, v_cust2,
      UPPER(LEFT(v_cust1::TEXT, 8)),
      'rewarded', 50000
    ) ON CONFLICT DO NOTHING;
  END IF;

  RAISE NOTICE 'Dev seed data applied successfully!';
END $$;
