-- Seed for the 00664 rehearsal, run after supabase/tests/00661/seed.sql. The sign-in address of
-- every seeded account (auth.users.email) and the people the account cases need:
--   SAM ANA MIA CARL DIEGO DORA: proven (a verified Google identity with the same address).
--     CARL also has a confirmed phone, which a proven account keeps.
--   PETE password only (identity 'email'), no phone                  -> password_only
--   PHIL password only plus a confirmed phone and a phone identity   -> needs_google
--   EVE  a Google identity with the address that is not verified     -> needs_google
--   BOB  public.users.is_active false                                -> blocked
--   BEN  banned in GoTrue (banned_until in the future)               -> blocked
--   nina@bacoagency.com has no account                               -> new (tests create NINA)
SET ROLE postgres;
UPDATE auth.users au SET email = v.email, created_at = '2026-01-01'
FROM (VALUES
  ('a1000000-0000-4000-8000-000000000001'::uuid, 'sam@example.com'),
  ('a1000000-0000-4000-8000-000000000002'::uuid, 'ana@example.com'),
  ('a1000000-0000-4000-8000-000000000003'::uuid, 'mia@example.com'),
  ('a1000000-0000-4000-8000-000000000004'::uuid, 'carl@gmail.com'),
  ('a1000000-0000-4000-8000-000000000005'::uuid, 'diego@gmail.com'),
  ('a1000000-0000-4000-8000-000000000006'::uuid, 'pete@example.com'),
  ('a1000000-0000-4000-8000-000000000007'::uuid, 'bob@gmail.com'),
  ('a1000000-0000-4000-8000-000000000008'::uuid, 'eve@gmail.com'),
  ('a1000000-0000-4000-8000-000000000009'::uuid, 'dora@gmail.com'),
  ('a1000000-0000-4000-8000-00000000000a'::uuid, 'old@example.com'),
  ('00000000-0000-0000-0000-000000000001'::uuid, 'platform@tricigo.system')) v (id, email)
WHERE au.id = v.id;
UPDATE auth.users SET phone = '5355550104', phone_confirmed_at = '2026-02-01'
WHERE id = 'a1000000-0000-4000-8000-000000000004';

INSERT INTO public.users (id, email, full_name, role) VALUES
  ('a1000000-0000-4000-8000-00000000000b', 'phil@example.com', 'Phil Phone',  'customer'),
  ('a1000000-0000-4000-8000-00000000000c', 'ben@gmail.com',    'Ben Banned',  'customer');
INSERT INTO auth.users (id, email, phone, phone_confirmed_at, banned_until, created_at) VALUES
  ('a1000000-0000-4000-8000-00000000000b', 'phil@example.com', '5355550111', '2026-02-01', NULL, '2026-01-01'),
  ('a1000000-0000-4000-8000-00000000000c', 'ben@gmail.com', NULL, NULL, now() + interval '100 years', '2026-01-01');
INSERT INTO auth.identities (user_id, provider, identity_data) VALUES
  ('a1000000-0000-4000-8000-00000000000b', 'email',  '{"email": "phil@example.com", "email_verified": true}'),
  ('a1000000-0000-4000-8000-00000000000b', 'phone',  '{"phone": "5355550111"}'),
  ('a1000000-0000-4000-8000-00000000000c', 'google', '{"email": "ben@gmail.com", "email_verified": true}');
RESET ROLE;
