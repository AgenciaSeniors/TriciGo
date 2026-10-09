-- Seed for the 00649 rehearsal. Runs as the owner (postgres): no trigger guard applies to it.
SET ROLE postgres;
INSERT INTO public.cities (id, name) VALUES
  ('c1000000-0000-4000-8000-000000000001', 'La Habana'),
  ('c1000000-0000-4000-8000-000000000002', 'Santiago de Cuba');

INSERT INTO auth.users (id) VALUES
  ('a0000000-0000-4000-8000-0000000000a1'), ('a0000000-0000-4000-8000-0000000000b1'),
  ('a0000000-0000-4000-8000-0000000000b2'), ('a0000000-0000-4000-8000-0000000000e1'),
  ('a0000000-0000-4000-8000-000000000c01'), ('a0000000-0000-4000-8000-000000000c02'),
  ('a0000000-0000-4000-8000-000000000c03'), ('a0000000-0000-4000-8000-000000000c04'),
  ('a0000000-0000-4000-8000-000000000d01'), ('a0000000-0000-4000-8000-000000000d02');

-- a1 admin, b1/b2 marketing, e1 a customer with no rides used only as a caller,
-- c01..c04 customers, d01/d02 drivers. full_name is the label the suite prints.
INSERT INTO public.users (id, full_name, role, is_active, city_id, created_at) VALUES
  ('a0000000-0000-4000-8000-0000000000a1', 'admin',     'admin',     true,  NULL, now() - interval '200 days'),
  ('a0000000-0000-4000-8000-0000000000b1', 'mkt1',      'marketing', true,  NULL, now() - interval '200 days'),
  ('a0000000-0000-4000-8000-0000000000b2', 'mkt2',      'marketing', true,  NULL, now() - interval '200 days'),
  ('a0000000-0000-4000-8000-0000000000e1', 'caller',    'customer',  true,  'c1000000-0000-4000-8000-000000000002', now() - interval '200 days'),
  ('a0000000-0000-4000-8000-000000000c01', 'c_new',     'customer',  true,  'c1000000-0000-4000-8000-000000000001', now() - interval '2 days'),
  ('a0000000-0000-4000-8000-000000000c02', 'c_power',   'customer',  true,  NULL, now() - interval '100 days'),
  ('a0000000-0000-4000-8000-000000000c03', 'c_active',  'customer',  true,  'c1000000-0000-4000-8000-000000000002', now() - interval '100 days'),
  ('a0000000-0000-4000-8000-000000000c04', 'c_blocked', 'customer',  false, 'c1000000-0000-4000-8000-000000000001', now() - interval '1 day'),
  ('a0000000-0000-4000-8000-000000000d01', 'd_power',   'driver',    true,  NULL, now() - interval '100 days'),
  ('a0000000-0000-4000-8000-000000000d02', 'd_idle',    'driver',    true,  NULL, now() - interval '2 days');

INSERT INTO public.driver_profiles (id, user_id, total_rides, total_rides_completed) VALUES
  ('dd000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000d01', 0, 11),
  ('dd000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000d02', 0, 0);

-- c_power: 11 rides, all 40 days ago. c_blocked: 11 old rides too (must still be excluded).
INSERT INTO public.rides (customer_id, created_at)
SELECT 'a0000000-0000-4000-8000-000000000c02', now() - interval '40 days' FROM generate_series(1, 11);
INSERT INTO public.rides (customer_id, created_at)
SELECT 'a0000000-0000-4000-8000-000000000c04', now() - interval '40 days' FROM generate_series(1, 11);
-- c_active rode 3 days ago, driven by d_power. 'caller' rode 1 day ago.
INSERT INTO public.rides (customer_id, driver_id, created_at) VALUES
  ('a0000000-0000-4000-8000-000000000c03', 'dd000000-0000-4000-8000-000000000001', now() - interval '3 days'),
  ('a0000000-0000-4000-8000-0000000000e1', NULL, now() - interval '1 day');

-- One campaign per segment, as drafts so the dispatcher never sees them.
INSERT INTO public.campaigns (id, name, segment_type, segment_city_id, audience_role, message_title, message_body, status) VALUES
  ('ca000000-0000-4000-8000-000000000001', 'all_c',      'all',         NULL, 'customer', 't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000002', 'new_c',      'new_users',   NULL, 'customer', 't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000003', 'power_c',    'power_users', NULL, 'customer', 't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000004', 'inactive_c', 'inactive',    NULL, 'customer', 't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000005', 'city_hav',   'by_city', 'c1000000-0000-4000-8000-000000000001', 'customer', 't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000006', 'city_null',  'by_city',     NULL, 'customer', 't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000007', 'all_d',      'all',         NULL, 'driver',   't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000008', 'new_d',      'new_users',   NULL, 'driver',   't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000009', 'power_d',    'power_users', NULL, 'driver',   't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000010', 'inactive_d', 'inactive',    NULL, 'driver',   't', 'b', 'draft'),
  ('ca000000-0000-4000-8000-000000000011', 'unknown',    'whatever',    NULL, 'customer', 't', 'b', 'draft');
RESET ROLE;
