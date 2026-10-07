-- Seed for the 00635 rehearsal. Every address is fake (.test). The recipients cover each
-- way an address can reach users.email:
--   VICTIM  typed in the profile, never confirmed (add-email-with-verification)
--   FLAG    confirmed through confirm-email (email_verified_at)
--   GMAIL   Google identity with the same address, verified by Google
--   CASE    Google identity, same address with other case and spaces
--   GX      Google identity, but users.email was changed to another address
--   GF      Google identity with the same address, NOT verified by Google
--   APPLE   Apple identity (email_verified as the string "true", as Apple sends it)
--   PW      a password ("email" provider) identity: GoTrue's open signup, no proof
--   NONE    no address at all
--   THIEF   typed GMAIL's address: a verified identity of ANOTHER account proves nothing
SET ROLE postgres;

INSERT INTO public.users (id, role, full_name, email, email_verified_at) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'customer', 'Ana',    'ana@x.test',  NULL),
  ('a0000000-0000-4000-8000-000000000002', 'customer', 'Beto',   'beto@x.test', NULL),
  ('a0000000-0000-4000-8000-000000000003', 'admin',    'Ada',    NULL,          NULL),
  ('c0000000-0000-4000-8000-000000000001', 'customer', 'Visita la web de spam', 'victim@x.test', NULL),
  ('c0000000-0000-4000-8000-000000000002', 'customer', 'Flor',   'flag@x.test', now() - interval '1 day'),
  ('c0000000-0000-4000-8000-000000000003', 'customer', 'Gabi',   'gmail@x.test', NULL),
  ('c0000000-0000-4000-8000-000000000004', 'customer', 'Carla',  ' Case@X.test ', NULL),
  ('c0000000-0000-4000-8000-000000000005', 'customer', 'Gus',    'victim2@x.test', NULL),
  ('c0000000-0000-4000-8000-000000000006', 'customer', 'Gema',   'gf@x.test', NULL),
  ('c0000000-0000-4000-8000-000000000007', 'customer', 'Alba',   'relay@privaterelay.test', NULL),
  ('c0000000-0000-4000-8000-000000000008', 'customer', 'Pablo',  'pw@x.test', NULL),
  ('c0000000-0000-4000-8000-000000000009', 'customer', 'Nadia',  NULL, NULL),
  ('d0000000-0000-4000-8000-0000000000a1', 'driver',   'Dani',   'dunv@x.test', NULL),
  ('d0000000-0000-4000-8000-0000000000a2', 'driver',   'Dora',   'dver@x.test', now() - interval '1 day'),
  ('e0000000-0000-4000-8000-000000000001', 'customer', 'Rita www.spam.example Gratis', NULL, NULL),
  ('e0000000-0000-4000-8000-000000000002', 'customer', 'Raul',   NULL, NULL),
  -- THIEF typed the address of GMAIL's verified Google identity; it proves nothing for THIEF
  ('c0000000-0000-4000-8000-00000000000a', 'customer', 'Tito',   'gmail@x.test', NULL);

INSERT INTO auth.identities (user_id, provider, identity_data) VALUES
  ('c0000000-0000-4000-8000-000000000003', 'google', '{"email": "gmail@x.test", "email_verified": true}'),
  ('c0000000-0000-4000-8000-000000000004', 'google', '{"email": "case@x.test", "email_verified": true}'),
  ('c0000000-0000-4000-8000-000000000005', 'google', '{"email": "own@x.test", "email_verified": true}'),
  ('c0000000-0000-4000-8000-000000000006', 'google', '{"email": "gf@x.test", "email_verified": false}'),
  ('c0000000-0000-4000-8000-000000000007', 'apple',  '{"email": "relay@privaterelay.test", "email_verified": "true"}'),
  ('c0000000-0000-4000-8000-000000000008', 'email',  '{"email": "pw@x.test", "email_verified": true}');

INSERT INTO public.driver_profiles (id, user_id) VALUES
  ('d1000000-0000-4000-8000-0000000000a1', 'd0000000-0000-4000-8000-0000000000a1'),
  ('d1000000-0000-4000-8000-0000000000a2', 'd0000000-0000-4000-8000-0000000000a2');

INSERT INTO public.wallet_accounts (user_id, account_type, balance) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'customer_cash', 1000000),
  ('a0000000-0000-4000-8000-000000000002', 'customer_cash', 1000000);

-- Rita (whose full_name carries a link) has four contacts: friend@ twice (other case and
-- spaces: the same inbox), second@, and one by phone. Raul names friend@ too.
INSERT INTO public.trusted_contacts (user_id, name, email, phone) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'Amiga <b>click</b>', 'friend@x.test', NULL),
  ('e0000000-0000-4000-8000-000000000001', 'Amiga2', ' FRIEND@x.test', NULL),
  ('e0000000-0000-4000-8000-000000000001', 'Primo',  'second@x.test', NULL),
  ('e0000000-0000-4000-8000-000000000001', 'Tia',    NULL, '+5355555555'),
  ('e0000000-0000-4000-8000-000000000002', 'Amiga',  ' Friend@X.test', NULL);

RESET ROLE;
