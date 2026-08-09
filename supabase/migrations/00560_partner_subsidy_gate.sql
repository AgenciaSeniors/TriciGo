-- 00560_partner_subsidy_gate.sql
--
-- Abre el subsidio de 00481 al descuento de lugar aliado, para que el conductor
-- cobre entero y la plataforma absorba el descuento.
--
-- 00481 introdujo "conductor entero, plataforma absorbe" para los promos, pero
-- lo condicionó a que existiera un código promo:
--
--     IF v_promo_disc > 0 AND v_ride.promo_code_id IS NOT NULL THEN
--
-- Un descuento de lugar aliado NO tiene promo_code_id, así que sin este cambio
-- el subsidio no se dispararía y **el conductor se comería el descuento** — lo
-- contrario exacto del modelo. Es el único punto de complete_ride_and_pay que
-- hay que tocar.
--
-- La fórmula interna no se cambia y no hace falta cambiarla: v_gross_no_promo
-- excluye únicamente el descuento de viaje compartido, así que ya deja al
-- conductor entero frente a cualquier otro descuento, venga de donde venga.
--
-- Por qué un patch in-place y no reescribir la función: complete_ride_and_pay
-- tiene ~28.7k caracteres. Reescribirla verbatim puede PERDER features en
-- silencio — pasó en 00124, que al copiar una versión vieja borró dos casos que
-- otras migraciones habían agregado. El patch parte del cuerpo VIVO, así que no
-- puede perder nada.
--
-- Pre-vuelo verificado al escribir esta migración:
--   ocurrencias del literal = 1   (única, el replace no puede tocar otra cosa)
--   md5(prosrc)             = 4bac6be392c312bedfc93fc04da508ec
--   length(prosrc)          = 28729

DO $patch$
DECLARE
  v_src TEXT;
  v_old TEXT;
  v_new TEXT;
  v_hits INT;
BEGIN
  v_old := 'IF v_promo_disc > 0 AND v_ride.promo_code_id IS NOT NULL THEN';
  v_new := 'IF v_promo_disc > 0 AND (v_ride.promo_code_id IS NOT NULL '
        || 'OR COALESCE(v_ride.partner_discount_cup, 0) > 0) THEN';

  SELECT pg_get_functiondef(oid) INTO v_src
  FROM pg_proc
  WHERE proname = 'complete_ride_and_pay' AND pronamespace = 'public'::regnamespace;

  IF v_src IS NULL THEN
    RAISE NOTICE '[00560] complete_ride_and_pay ausente; se omite';
    RETURN;
  END IF;

  -- Idempotente: re-aplicar la migración no vuelve a parchear.
  IF position(v_new IN v_src) > 0 THEN
    RAISE NOTICE '[00560] ya aplicado; sin cambios';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    -- Fallar ruidoso en vez de parchear a ciegas: si el gate cambió de forma,
    -- alguien tiene que mirarlo antes de tocar el reparto de dinero.
    RAISE EXCEPTION '[00560] se esperaba 1 ocurrencia del gate del subsidio, se encontraron % — revisar a mano', v_hits;
  END IF;

  EXECUTE replace(v_src, v_old, v_new);
  RAISE NOTICE '[00560] gate del subsidio abierto al descuento de lugar aliado';
END $patch$;
