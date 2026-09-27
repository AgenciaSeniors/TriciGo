-- Accounts for the 00605 rehearsal (run.sh reloads this before every test, with
-- no JWT set). They go in the way GoTrue creates them: an INSERT into
-- auth.users, whose on_auth_user_created trigger creates the public.users row.
TRUNCATE auth.users, public.users, public.driver_profiles, public.wallet_accounts, public.rpc_attempt_log RESTART IDENTITY;
INSERT INTO auth.users (id, email, phone, phone_confirmed_at, raw_user_meta_data) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'phone_5355550001@tricigo.app', '5355550001', '2026-09-01 12:00:00+00', '{"full_name": "Alice"}'), -- customer
  ('a0000000-0000-4000-8000-000000000002', 'phone_5355550002@tricigo.app', '5355550002', '2026-09-01 12:00:00+00', '{"full_name": "Bob"}'),   -- approved driver
  ('a0000000-0000-4000-8000-000000000003', 'carol@example.com',            NULL,          NULL,                     '{"full_name": "Carol"}'), -- admin
  ('a0000000-0000-4000-8000-000000000008', 'phone_5355550008@tricigo.app', '5355550008', '2026-09-01 12:00:00+00', '{"full_name": "Olga"}');  -- loses her public row below
UPDATE public.users SET role = 'driver' WHERE id = 'a0000000-0000-4000-8000-000000000002';
UPDATE public.users SET role = 'admin'  WHERE id = 'a0000000-0000-4000-8000-000000000003';
INSERT INTO public.driver_profiles (id, user_id, status) VALUES
  ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'approved');
-- The shape the attack needs: an account whose public.users row is gone while
-- its auth.users row (and so its sessions) remains. 0 of them in prod on
-- 2026-09-26; an operator repair, a restore or a wipe could leave one.
DELETE FROM public.users WHERE id = 'a0000000-0000-4000-8000-000000000008';
