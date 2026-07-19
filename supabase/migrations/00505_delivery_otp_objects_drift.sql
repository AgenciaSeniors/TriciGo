-- 00505: Bring the delivery-OTP columns, generator function and BEFORE INSERT
--        trigger into git. DRIFT FIX — reproduced verbatim from prod, so
--        applying this to prod is a no-op.
--
-- WHAT IS MISSING FROM GIT (verified against prod today, object by object):
--   delivery_details.delivery_otp                  — no migration creates it
--   delivery_details.delivery_otp_validated_at     — no migration creates it
--   public.generate_delivery_otp()                 — no migration defines it
--   trg_delivery_details_generate_otp              — no migration creates it
--                                                    (00384 only NAMES it in a comment)
--
-- Already in git, deliberately NOT duplicated here:
--   tg_delivery_details_protect_otp() + trg_delivery_details_protect_otp — 00438
--   validate_delivery_otp()                                             — 00438
--   notify_delivery_recipient_on_accept()                               — 00384
--
-- WHY IT MATTERS
-- 00438 defines tg_delivery_details_protect_otp(), whose body reads
-- NEW.delivery_otp / OLD.delivery_otp, and 00384's SMS body SELECTs the OTP —
-- both against columns that exist nowhere in the migration history. Rebuild from
-- migrations alone and delivery_otp is absent: the recipient OTP the driver asks
-- for at drop-off is never generated, and nothing in the repo explains why.
--
-- ORDERING NOTE (honest limitation): this lands at 00505, i.e. AFTER 00438. On a
-- full rebuild that is fine — plpgsql resolves NEW.<column> at execution, not at
-- CREATE, so 00438 still applies cleanly and the end state is correct. But
-- between 00438 and here the protect trigger would error if a row were inserted.
-- Nothing inserts during a migration run, so this is theoretical; recorded so the
-- next reader does not have to re-derive it.

-- ── Columns ──────────────────────────────────────────────────────────────────
ALTER TABLE public.delivery_details
  ADD COLUMN IF NOT EXISTS delivery_otp              TEXT,
  ADD COLUMN IF NOT EXISTS delivery_otp_validated_at TIMESTAMPTZ;

COMMENT ON COLUMN public.delivery_details.delivery_otp IS
  '4-digit code the recipient gives the driver at drop-off. Auto-generated on INSERT '
  'by trg_delivery_details_generate_otp; immutable for non-admin/non-trusted writers '
  '(tg_delivery_details_protect_otp, 00438).';

-- ── Generator ────────────────────────────────────────────────────────────────
-- Verbatim from prod (pg_get_functiondef). Note: NOT security definer, and it
-- only fills the value when the caller left it NULL, so an explicitly supplied
-- OTP is preserved.
CREATE OR REPLACE FUNCTION public.generate_delivery_otp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.delivery_otp IS NULL THEN
    NEW.delivery_otp := lpad((floor(random() * 10000))::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$function$;

-- ── Trigger ──────────────────────────────────────────────────────────────────
-- DROP + CREATE so the migration is idempotent (CREATE TRIGGER has no IF NOT
-- EXISTS). Dropping and recreating a BEFORE INSERT trigger cannot affect rows
-- that already exist.
DROP TRIGGER IF EXISTS trg_delivery_details_generate_otp ON public.delivery_details;
CREATE TRIGGER trg_delivery_details_generate_otp
  BEFORE INSERT ON public.delivery_details
  FOR EACH ROW EXECUTE FUNCTION public.generate_delivery_otp();
