-- 00455_null_synthetic_emails_public_users.sql
-- Clear the synthetic phone-OTP placeholder email (`phone_<digits>@tricigo.app`)
-- from public.users.email.
--
-- Background: the verify-otp Edge Function creates every phone-OTP account in
-- auth.users with a synthetic email `phone_<phone>@tricigo.app`. That value is
-- load-bearing for session minting (magic-link / password grant), so it must
-- stay in auth.users — but it is NOT a real address the user owns. A few legacy
-- rows leaked it into public.users.email, where transactional email senders
-- (welcome / win-back / receipts) read it and would bounce.
--
-- This migration ONLY clears the placeholder from public.users.email. It does
-- NOT touch auth.users.email (removing it there would break login).
-- Idempotent: once the rows are NULL, re-running is a no-op.

UPDATE public.users
SET email = NULL
WHERE email ~* '^phone_\d+@tricigo\.app$';
