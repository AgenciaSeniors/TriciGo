-- 00493: Bring the delivery-OTP objects into git (drift fix, NOT a behavior change).
--
-- generate_delivery_otp() + its BEFORE INSERT trigger on delivery_details and
-- the delivery_otp / delivery_otp_validated_at columns were created manually in
-- prod and never committed as a migration. A rebuild from migrations alone would
-- omit them → delivery_otp NULL and recipient OTP validation broken, with no git
-- artifact to explain it. This recreates them verbatim & idempotently so the
-- repo matches prod. Applying it to prod is a harmless no-op.

ALTER TABLE public.delivery_details
  ADD COLUMN IF NOT EXISTS delivery_otp TEXT,
  ADD COLUMN IF NOT EXISTS delivery_otp_validated_at TIMESTAMPTZ;

-- Auto-generate a 4-digit OTP on insert when one isn't supplied. Uses only
-- pg_catalog builtins (random/lpad); search_path pinned to include extensions
-- to match prod and stay safe if that ever changes.
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

DROP TRIGGER IF EXISTS trg_delivery_details_generate_otp ON public.delivery_details;
CREATE TRIGGER trg_delivery_details_generate_otp
  BEFORE INSERT ON public.delivery_details
  FOR EACH ROW EXECUTE FUNCTION public.generate_delivery_otp();
