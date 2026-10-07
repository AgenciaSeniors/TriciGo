-- Seed for the 00630 rehearsal. Fake values of the same shape as prod's.
-- Written with triggers off (session_replication_role = replica), so the rows land as
-- they are, without dispatching anything. The tests run with every trigger on.
SET session_replication_role = replica;

INSERT INTO public.users (id, role) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'customer'),   -- ROSA: her ride is searching
  ('a0000000-0000-4000-8000-000000000002', 'customer'),   -- MALLO: any other signed-in customer
  ('a0000000-0000-4000-8000-000000000003', 'admin'),      -- ADA
  ('b0000000-0000-4000-8000-0000000000d1', 'driver'),
  ('b0000000-0000-4000-8000-0000000000d2', 'driver'),
  ('b0000000-0000-4000-8000-0000000000d3', 'driver'),
  ('b0000000-0000-4000-8000-0000000000d4', 'driver');

INSERT INTO public.customer_profiles (user_id, rating_avg) VALUES
  ('a0000000-0000-4000-8000-000000000001', 4.90),
  ('a0000000-0000-4000-8000-000000000002', 4.50);

-- D1, D2 and D4 are online; D3 is offline (it connects in K3). Points are 'POINT(lng lat)'.
INSERT INTO public.driver_profiles (id, user_id, is_online, current_location) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000d1', true,  'POINT(-82.3700 23.1360)'),
  ('d0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-0000000000d2', true,  'POINT(-82.3800 23.1300)'),
  ('d0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-0000000000d3', false, 'POINT(-82.3900 23.1200)'),
  ('d0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-0000000000d4', true,  'POINT(-82.4000 23.1100)');

-- The dispatch settings, with their prod values on 2026-10-07
INSERT INTO public.platform_config (key, value) VALUES
  ('offer_ttl_seconds', '60'),
  ('reoffer_cooldown_s', '120'),
  ('dispatch_stage1_seconds', '45'),
  ('dispatch_stage1_radius_m', '8000'),
  ('dispatch_max_radius_m', '50000'),
  ('dispatch_offer_limit', '0'),
  ('low_rating_rider_threshold', '3.0'),
  ('low_rating_rider_dispatch_limit', '5'),
  ('low_rating_rider_radius_m', '3000');

-- RIDE_A, Rosa's ride, searching for 7 minutes. Round 1 offered it to D1 and D2; both
-- offers expired 5 minutes ago, past the 120 s cooldown, so the next round re-arms
-- them. D4 has no offer on it yet.
INSERT INTO public.rides (id, customer_id, service_type, status, pickup_location, pickup_address,
                          estimated_fare_cup, estimated_distance_m, created_at, dispatch_round, last_dispatched_at)
VALUES ('f0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001', 'triciclo_basico',
        'searching', 'POINT(-82.3666 23.1357)', 'Capitolio, Centro Habana', 1500, 4200,
        now() - interval '7 minutes', 1, now() - interval '6 minutes');
INSERT INTO public.ride_offers (ride_id, driver_profile_id, status, composite_score, distance_m, offered_at, expires_at) VALUES
  ('f0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-000000000001', 'expired', 0.75, 800,
   now() - interval '6 minutes', now() - interval '5 minutes'),
  ('f0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-000000000002', 'expired', 0.75, 800,
   now() - interval '6 minutes', now() - interval '5 minutes');

RESET session_replication_role;
