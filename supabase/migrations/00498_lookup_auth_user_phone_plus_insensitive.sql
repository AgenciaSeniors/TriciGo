-- 00498_lookup_auth_user_phone_plus_insensitive.sql
--
-- Fix OTP login 500 for accounts that originated from Google/email and later
-- linked a phone identity (e.g. "signed up with Google, now logs in with SMS").
--
-- ROOT CAUSE
-- ----------
-- verify-otp calls lookup_auth_user_by_contact(devEmail, normalizedPhone) where
-- normalizedPhone always carries a leading '+' (index.ts: `phone.startsWith('+')
-- ? phone : '+'+phone`). GoTrue, however, stores auth.users.phone WITHOUT the '+'
-- (E.164 digits only, e.g. '5359747155'). The lookup compared phone by EXACT
-- string equality (`u.phone = p_phone`), so '+5359747155' never matched the stored
-- '5359747155' → the phone branch of this lookup was effectively DEAD for everyone.
--
-- Normal phone-origin users were still found via the EMAIL branch, because their
-- auth.users.email IS the synthetic `phone_<digits>@tricigo.app`. But users whose
-- email is a REAL address (Google/email signup) match NEITHER branch:
--   * email branch: real gmail <> synthetic phone_*@tricigo.app  → miss
--   * phone branch: '5359747155' <> '+5359747155'                → miss (the '+')
-- → lookup returns NULL → verify-otp falls through to createUser({phone:'+…'})
-- → GoTrue phone-uniqueness collision with the existing row → HTTP 500. The OTP is
-- already verified/burned, so the retry then shows "Código incorrecto".
--
-- FIX
-- ---
-- Compare the phone ignoring a leading '+' on either side (ltrim(...,'+')). This
-- revives the phone branch so the existing user is found; verify-otp then takes the
-- existingUserId path and mints the session normally. No behaviour change for
-- synthetic-email users (they still match by email, and now also by phone — same row).
--
-- Same signature / return type / volatility / security context as the live function.

CREATE OR REPLACE FUNCTION public.lookup_auth_user_by_contact(p_email text, p_phone text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT u.id
  FROM auth.users u
  WHERE (p_phone IS NOT NULL AND p_phone <> ''
         AND ltrim(u.phone, '+') = ltrim(p_phone, '+'))
     OR (p_email IS NOT NULL AND p_email <> '' AND u.email = p_email)
  ORDER BY (p_phone IS NOT NULL AND ltrim(u.phone, '+') = ltrim(p_phone, '+'))
             DESC NULLS LAST,
           u.created_at ASC
  LIMIT 1;
$function$;
