-- Accounts and rides for the 00607 rehearsal (run.sh reloads this before every
-- test, as the superuser and with no JWT set, so no trigger guard applies).
TRUNCATE public.ride_disputes, public.customer_profiles, public.rides, public.driver_profiles, public.users, auth.users CASCADE;
INSERT INTO auth.users (id) VALUES
  ('a0000000-0000-4000-8000-000000000001'),  -- Alice, rider
  ('a0000000-0000-4000-8000-000000000002'),  -- Bob, driver
  ('a0000000-0000-4000-8000-000000000003'),  -- Carol, admin
  ('a0000000-0000-4000-8000-000000000004'),  -- Dave, a rider with nothing to do with Alice's rides
  ('a0000000-0000-4000-8000-000000000005');  -- Erin, a rider who has no customer profile yet
INSERT INTO public.users (id, full_name, role) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Alice', 'customer'),
  ('a0000000-0000-4000-8000-000000000002', 'Bob',   'driver'),
  ('a0000000-0000-4000-8000-000000000003', 'Carol', 'admin'),
  ('a0000000-0000-4000-8000-000000000004', 'Dave',  'customer'),
  ('a0000000-0000-4000-8000-000000000005', 'Erin',  'customer');
INSERT INTO public.driver_profiles (id, user_id) VALUES
  ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002');
INSERT INTO public.rides (id, customer_id, driver_id, status, payment_method, wallet_ratio, estimated_fare_trc, final_fare_trc) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'completed', 'cash', 0, 3000, 3000),
  ('e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', NULL, 'searching', 'mixed', 0.5, 3000, NULL),
  ('e0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', NULL, 'completed', 'cash', 0, 2000, 2000);
INSERT INTO public.customer_profiles (user_id, rating_avg) VALUES
  ('a0000000-0000-4000-8000-000000000001', 4.20),
  ('a0000000-0000-4000-8000-000000000004', 5.00);
