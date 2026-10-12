-- Seed for the 00660 rehearsal. People and their Google/Apple identities; run.sh says which case
-- uses whom.
--   SAM  super_admin, proven address (Google)        ANA  admin, proven address (Google)
--   MIA  marketing: users.email differs from her Google address, so not proven
--   CARL customer, Google address with capitals and a trailing space
--   DIEGO driver (approved profile), Google          PETE customer, password only
--   BOB  customer, blocked, Google                   EVE  customer, Google not verified
--   DORA customer with a pending driver profile, Google
--   OLD  admin, blocked                              PLAT/ANON the two system accounts
SET ROLE postgres;
INSERT INTO public.users (id, email, full_name, role, is_active, email_verified_at) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'sam@example.com',      'Sam Super',     'super_admin', true,  NULL),
  ('a1000000-0000-4000-8000-000000000002', 'ana@example.com',      'Ana Admin',     'admin',       true,  NULL),
  ('a1000000-0000-4000-8000-000000000003', 'mia.work@example.com', 'Mia Marketing', 'marketing',   true,  NULL),
  ('a1000000-0000-4000-8000-000000000004', 'carl@gmail.com',       'Carl Cliente',  'customer',    true,  NULL),
  ('a1000000-0000-4000-8000-000000000005', 'diego@gmail.com',      'Diego Driver',  'driver',      true,  NULL),
  ('a1000000-0000-4000-8000-000000000006', 'pete@example.com',     'Pete Password', 'customer',    true,  NULL),
  ('a1000000-0000-4000-8000-000000000007', 'bob@gmail.com',        'Bob Blocked',   'customer',    false, NULL),
  ('a1000000-0000-4000-8000-000000000008', 'eve@gmail.com',        'Eve Unverified','customer',    true,  NULL),
  ('a1000000-0000-4000-8000-000000000009', 'dora@gmail.com',       'Dora Pending',  'customer',    true,  NULL),
  ('a1000000-0000-4000-8000-00000000000a', 'old@example.com',      'Old Admin',     'admin',       false, '2026-01-01'),
  ('00000000-0000-0000-0000-000000000001', 'platform@tricigo.system', 'TriciGo Platform', 'super_admin', true, '2026-01-01'),
  ('00000000-0000-0000-0000-000000000099', NULL,                   'Usuario eliminado', 'customer', true, NULL);
INSERT INTO auth.users (id, last_sign_in_at) SELECT id, NULL FROM public.users;
UPDATE auth.users SET last_sign_in_at = '2026-10-11 12:00:00+00' WHERE id = 'a1000000-0000-4000-8000-000000000001';
INSERT INTO auth.identities (user_id, provider, identity_data) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'google', '{"email": "sam@example.com", "email_verified": true}'),
  ('a1000000-0000-4000-8000-000000000002', 'google', '{"email": "ana@example.com", "email_verified": true}'),
  ('a1000000-0000-4000-8000-000000000003', 'google', '{"email": "mia@example.com", "email_verified": true}'),
  ('a1000000-0000-4000-8000-000000000004', 'google', '{"email": "Carl@Gmail.com ", "email_verified": true}'),
  ('a1000000-0000-4000-8000-000000000005', 'google', '{"email": "diego@gmail.com", "email_verified": true}'),
  ('a1000000-0000-4000-8000-000000000006', 'email',  '{"email": "pete@example.com", "email_verified": true}'),
  ('a1000000-0000-4000-8000-000000000007', 'google', '{"email": "bob@gmail.com", "email_verified": true}'),
  ('a1000000-0000-4000-8000-000000000008', 'google', '{"email": "eve@gmail.com", "email_verified": false}'),
  ('a1000000-0000-4000-8000-000000000009', 'google', '{"email": "dora@gmail.com", "email_verified": true}');
INSERT INTO public.driver_profiles (user_id, status) VALUES
  ('a1000000-0000-4000-8000-000000000005', 'approved'),
  ('a1000000-0000-4000-8000-000000000009', 'pending_verification');
RESET ROLE;
