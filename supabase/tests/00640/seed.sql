-- Seed for the 00640 rehearsal. Fixed timestamps (2026-01-01, UTC) so the tests can name
-- the token whose created_at must come back as link_sent_at.
INSERT INTO public.users (id, full_name, email, email_verified_at) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'Una', 'unc@x.test', NULL),                         -- UNC: typed, never confirmed
  ('c0000000-0000-4000-8000-000000000002', 'Flor', 'flag@x.test', '2026-01-01 08:00:00+00'),   -- FLAG: confirmed through confirm-email
  ('c0000000-0000-4000-8000-000000000003', 'Gabi', 'goog@x.test', NULL),                       -- GOOG: same address on a verified Google identity
  ('c0000000-0000-4000-8000-000000000004', 'Pepe', 'phone_5355555555@tricigo.app', NULL),      -- PHONE: the phone-OTP placeholder
  ('c0000000-0000-4000-8000-000000000005', 'Nadia', NULL, NULL),                               -- NOMAIL
  ('c0000000-0000-4000-8000-000000000006', 'Sara', ' Spaced@X.test ', NULL),                   -- SPACE: spaces and capitals
  ('c0000000-0000-4000-8000-000000000007', 'Gina', 'gnv@x.test', NULL),                        -- GNV: Google identity NOT verified by Google
  ('c0000000-0000-4000-8000-000000000008', 'Blanca', '   ', NULL);                             -- BLANK: only spaces

INSERT INTO auth.identities (user_id, provider, identity_data) VALUES
  ('c0000000-0000-4000-8000-000000000003', 'google', '{"email": "Goog@X.test", "email_verified": true}'),
  ('c0000000-0000-4000-8000-000000000007', 'google', '{"email": "gnv@x.test", "email_verified": false}');

INSERT INTO public.email_verification_tokens (user_id, email, token_hash, expires_at, used_at, created_at) VALUES
  -- UNC: only the two valid tokens for its address count; the newest (11:00) wins
  ('c0000000-0000-4000-8000-000000000001', 'unc@x.test',   'h-valid-10', '2999-01-01', NULL, '2026-01-01 10:00:00+00'),
  ('c0000000-0000-4000-8000-000000000001', 'unc@x.test',   'h-valid-11', '2999-01-01', NULL, '2026-01-01 11:00:00+00'),
  ('c0000000-0000-4000-8000-000000000001', 'unc@x.test',   'h-used-12',  '2999-01-01', '2026-01-01 12:30:00+00', '2026-01-01 12:00:00+00'),
  ('c0000000-0000-4000-8000-000000000001', 'unc@x.test',   'h-exp-13',   '2000-01-01', NULL, '2026-01-01 13:00:00+00'),
  ('c0000000-0000-4000-8000-000000000001', 'other@x.test', 'h-other-14', '2999-01-01', NULL, '2026-01-01 14:00:00+00'),
  -- FLAG holds a token for UNC's address: it is not UNC's link
  ('c0000000-0000-4000-8000-000000000002', 'unc@x.test',   'h-flag-15',  '2999-01-01', NULL, '2026-01-01 15:00:00+00'),
  -- SPACE: the token stores the address lowercased, as add-email-with-verification does
  ('c0000000-0000-4000-8000-000000000006', 'spaced@x.test', 'h-space-09', '2999-01-01', NULL, '2026-01-01 09:00:00+00');
