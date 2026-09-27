-- Accounts for the 00599 rehearsal, modelled on the shapes that exist in prod
-- on 2026-09-25 (run.sh reloads this before every test, with no JWT set).
TRUNCATE auth.users, public.users, public.driver_profiles, public.rpc_attempt_log, public.rate_limit_calls RESTART IDENTITY;
INSERT INTO auth.users (id, email, phone, phone_confirmed_at) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'phone_5355550001@tricigo.app', '5355550001', '2026-09-01 12:00:00+00'),       -- Alice, customer, OTP sign-up
  ('a0000000-0000-4000-8000-000000000002', 'phone_5355550002@tricigo.app', '5355550002', '2026-09-01 12:00:00+00'),       -- Bob, approved driver
  ('a0000000-0000-4000-8000-000000000003', 'carol@example.com',            NULL,          NULL),                           -- Carol, admin, no auth phone
  ('a0000000-0000-4000-8000-000000000004', 'dave@example.com',             NULL,          NULL),                           -- Dave, super_admin, no auth phone
  ('a0000000-0000-4000-8000-000000000005', 'erin@example.com',             NULL,          NULL),                           -- Erin, Google sign-in, no phone yet
  ('a0000000-0000-4000-8000-000000000006', 'frank@example.com',            '5355550006', NULL),                           -- Frank, auth phone never confirmed
  ('a0000000-0000-4000-8000-000000000007', 'phone_5511999990007@tricigo.app', '5511999990007', '2026-09-01 12:00:00+00'); -- Grace, non-Cuban number
INSERT INTO public.users (id, phone, full_name, role) VALUES
  ('a0000000-0000-4000-8000-000000000001', '+5355550001',    'Alice', 'customer'),
  ('a0000000-0000-4000-8000-000000000002', '+5355550002',    'Bob',   'driver'),
  ('a0000000-0000-4000-8000-000000000003', '+5355550003',    'Carol', 'admin'),
  ('a0000000-0000-4000-8000-000000000004', '+5355550004',    'Dave',  'super_admin'),
  ('a0000000-0000-4000-8000-000000000005', NULL,             'Erin',  'customer'),
  ('a0000000-0000-4000-8000-000000000006', NULL,             'Frank', 'customer'),
  ('a0000000-0000-4000-8000-000000000007', '+5511999990007', 'Grace', 'customer');
INSERT INTO public.driver_profiles (id, user_id, status) VALUES
  ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'approved');
