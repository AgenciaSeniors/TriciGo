-- 00559_partner_discount_trigger.sql
--
-- Calcula server-side el descuento de lugar aliado y lo mete por el MISMO carril
-- que promos y viaje compartido: rides.discount_amount_cup.
--
-- Por qué extender este trigger en lugar de sumar el descuento desde el cliente:
-- `discount_amount_cup` es server-authoritative — este trigger lo RECOMPUTA en
-- cada INSERT/UPDATE (BUG-115, 00172, endurecido en 00320/00322/00399/00482/00492).
-- Cualquier valor que mandara el cliente lo borraría el propio trigger. Así que el
-- descuento del lugar se deriva de `dropoff_location` y no hay nada que falsificar.
--
-- El cuerpo se transcribió desde la versión VIVA en producción
-- (md5(prosrc) = 67392b0115252e44a31b4edec80aff31, 4372 chars), NO desde la
-- migración original: la función fue endurecida por 00399, 00482 y 00492 después.
--
-- Regla que gobierna la edición: el trigger tiene CINCO puntos donde asigna
-- discount_amount_cup. La pieza nueva se calcula una vez arriba y se arrastra por
-- TODAS las salidas, no solo por la feliz — la misma lección que dejó el descuento
-- de viaje compartido en 00347.
--
-- Nota sobre search_path: PostGIS vive en el esquema `public` en este cluster,
-- así que ST_DWithin/ST_Distance resuelven con el search_path que ya tenía la
-- función. No se cambia.

CREATE OR REPLACE FUNCTION public.tg_rides_validate_promo_discount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_promo RECORD;
  v_type TEXT;
  v_correct_discount INTEGER := 0;
  v_slot_claimed BOOLEAN := false;
  v_supplied_discount INTEGER := COALESCE(NEW.discount_amount_cup, 0);
  v_shared_discount INTEGER := 0;
  v_cap INTEGER;
  v_occ INTEGER;
  v_free INTEGER;
  v_pct NUMERIC;
  v_fare_base INTEGER;   -- 00399: immutable fare base for ALL discount math
  -- 00559: partner-place discount
  v_partner_discount INTEGER := 0;
  v_partner_id UUID;
  v_partner_pct NUMERIC;
  v_commission_rate NUMERIC;
  v_corp_rate NUMERIC;
BEGIN
  -- 00492: deleting a promotion cascades ON DELETE SET NULL onto
  -- rides.promo_code_id. On an already-finished ride, preserve the historical
  -- discount instead of recomputing it to 0 (promo deleted via ON DELETE SET NULL).
  -- 00559: this returns BEFORE the partner block on purpose — a finished ride
  -- keeps its historical partner_discount_cup / partner_place_id untouched.
  IF TG_OP = 'UPDATE'
     AND OLD.promo_code_id IS NOT NULL
     AND NEW.promo_code_id IS NULL
     AND NEW.status IN ('completed', 'canceled') THEN
    RETURN NEW;
  END IF;

  v_fare_base := COALESCE(
    (SELECT total FROM ride_pricing_snapshots
       WHERE ride_id = NEW.id AND snapshot_type = 'estimate' LIMIT 1),
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.estimated_fare_cup ELSE NEW.estimated_fare_cup END,
    0
  );

  IF COALESCE(NEW.shared_ride, false) AND NEW.service_type = 'triciclo_basico' THEN
    v_cap := COALESCE((SELECT max_passengers FROM service_type_configs WHERE slug = NEW.service_type), 4);
    v_occ := LEAST(GREATEST(COALESCE(NEW.shared_ride_seats_occupied, 1), 1), v_cap - 1);
    v_free := GREATEST(v_cap - v_occ, 0);
    v_pct := get_platform_config_numeric('shared_ride_discount_per_seat_pct', 7);
    NEW.shared_ride_seats_occupied := v_occ;
    v_shared_discount := LEAST(
      FLOOR(v_fare_base * v_free * v_pct / 100.0)::INTEGER,
      v_fare_base
    );
    NEW.shared_ride_discount_cup := v_shared_discount;
  ELSE
    NEW.shared_ride := false;
    NEW.shared_ride_seats_occupied := NULL;
    NEW.shared_ride_discount_cup := 0;
  END IF;

  -- ── 00559: descuento de lugar aliado ────────────────────────────────
  -- Derivado del destino, jamás de lo que manda el cliente.
  --
  -- El tope en la comisión efectiva NO es cosmético: es lo que sostiene el
  -- invariante del modelo. Con tarifa F, comisión c y descuento d, el neto de
  -- la plataforma es F(c−d), que solo es >= 0 mientras d <= c. Sin este tope,
  -- un lugar cargado al 50% haría que la plataforma pusiera plata propia.
  v_partner_discount := 0;
  NEW.partner_place_id := NULL;

  IF NEW.dropoff_location IS NOT NULL AND v_fare_base > 0 THEN
    SELECT pp.id, pp.discount_percent
      INTO v_partner_id, v_partner_pct
    FROM public.partner_places pp
    WHERE pp.is_active
      AND (pp.valid_until IS NULL OR pp.valid_until > now())
      AND ST_DWithin(pp.location, NEW.dropoff_location, pp.radius_m)
    ORDER BY ST_Distance(pp.location, NEW.dropoff_location)  -- radios solapados: gana el más cercano, nunca se suman
    LIMIT 1;

    IF v_partner_id IS NOT NULL THEN
      v_commission_rate := get_platform_config_numeric('commission_rate', 0.15);
      -- guarda de 00494: una comisión 0/NULL/>=1 es una config inválida, no "gratis"
      IF v_commission_rate IS NULL OR v_commission_rate <= 0 OR v_commission_rate >= 1 THEN
        v_commission_rate := 0.15;
      END IF;

      -- En un viaje corporativo la plataforma cobra la comisión corporativa, que
      -- es menor: el tope baja solo para que el invariante siga valiendo.
      IF NEW.corporate_account_id IS NOT NULL THEN
        SELECT commission_percent / 100.0 INTO v_corp_rate
        FROM public.corporate_accounts WHERE id = NEW.corporate_account_id;
        IF v_corp_rate IS NOT NULL AND v_corp_rate < v_commission_rate THEN
          v_commission_rate := v_corp_rate;
        END IF;
      END IF;

      v_partner_discount := GREATEST(LEAST(
        ROUND(v_fare_base * v_partner_pct / 100.0)::INTEGER,
        ROUND(v_fare_base * v_commission_rate)::INTEGER
      ), 0);

      IF v_partner_discount > 0 THEN
        NEW.partner_place_id := v_partner_id;
      END IF;
    END IF;
  END IF;

  IF is_super_admin() THEN
    IF v_supplied_discount <> 0 OR NEW.promo_code_id IS NOT NULL THEN
      INSERT INTO admin_promo_audit_log (
        admin_user_id, ride_id, customer_id,
        promo_code_id, discount_amount_cup_supplied,
        estimated_fare_cup, notes
      ) VALUES (
        auth.uid(), NEW.id, NEW.customer_id,
        NEW.promo_code_id, v_supplied_discount,
        NEW.estimated_fare_cup,
        format('TG_OP=%s super_admin bypass', TG_OP)
      );
    END IF;
    -- 00559: el bypass de super_admin sigue dejando pasar discount_amount_cup sin
    -- recomputar (escape hatch deliberado para soporte), pero la atribución al
    -- lugar se escribe con el valor del servidor, no con el que mandó el cliente.
    NEW.partner_discount_cup := v_partner_discount;
    RETURN NEW;
  END IF;

  IF NEW.promo_code_id IS NULL THEN
    NEW.partner_discount_cup := v_partner_discount;
    NEW.discount_amount_cup := LEAST(v_partner_discount + v_shared_discount, v_fare_base);
    RETURN NEW;
  END IF;

  SELECT * INTO v_promo FROM promotions WHERE id = NEW.promo_code_id;

  IF v_promo IS NULL
     OR NOT v_promo.is_active
     OR v_promo.valid_from > NOW()
     OR (v_promo.valid_until IS NOT NULL AND v_promo.valid_until <= NOW())
     -- 00482: first-ride-only promos are invalid once the customer has a completed ride
     OR (COALESCE(v_promo.first_ride_only, false) AND EXISTS (
       SELECT 1 FROM rides r0 WHERE r0.customer_id = NEW.customer_id AND r0.status = 'completed'
     ))
  THEN
    NEW.promo_code_id := NULL;
    NEW.partner_discount_cup := v_partner_discount;
    NEW.discount_amount_cup := LEAST(v_partner_discount + v_shared_discount, v_fare_base);
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    BEGIN
      INSERT INTO promotion_uses (promotion_id, user_id, ride_id)
      VALUES (v_promo.id, NEW.customer_id, NEW.id);
    EXCEPTION WHEN unique_violation THEN
      NEW.promo_code_id := NULL;
      NEW.partner_discount_cup := v_partner_discount;
      NEW.discount_amount_cup := LEAST(v_partner_discount + v_shared_discount, v_fare_base);
      RETURN NEW;
    END;

    UPDATE promotions
    SET current_uses = current_uses + 1
    WHERE id = v_promo.id
      AND (max_uses IS NULL OR current_uses < max_uses)
    RETURNING true INTO v_slot_claimed;

    IF NOT COALESCE(v_slot_claimed, false) THEN
      DELETE FROM promotion_uses
      WHERE promotion_id = v_promo.id
        AND user_id = NEW.customer_id
        AND ride_id = NEW.id;
      NEW.promo_code_id := NULL;
      NEW.partner_discount_cup := v_partner_discount;
      NEW.discount_amount_cup := LEAST(v_partner_discount + v_shared_discount, v_fare_base);
      RETURN NEW;
    END IF;
  END IF;

  v_type := v_promo.type::TEXT;

  IF v_type IN ('percentage_discount', 'bonus_credit') THEN
    v_correct_discount := LEAST(
      ROUND(v_fare_base * COALESCE(v_promo.discount_percent, 0) / 100.0)::INTEGER,
      v_fare_base
    );
  ELSIF v_type = 'fixed_discount' THEN
    v_correct_discount := LEAST(
      COALESCE(v_promo.discount_fixed_cup, 0),
      v_fare_base
    );
  ELSE
    v_correct_discount := 0;
  END IF;

  -- 00559: promo y lugar aliado NO se suman — gana el mayor. El perdedor aporta
  -- 0 para que el subsidio de 00481 no cuente dos veces el mismo descuento.
  IF v_partner_discount > GREATEST(v_correct_discount, 0) THEN
    NEW.partner_discount_cup := v_partner_discount;
    v_correct_discount := 0;
  ELSE
    NEW.partner_discount_cup := 0;
    NEW.partner_place_id := NULL;
  END IF;

  NEW.discount_amount_cup := LEAST(
    GREATEST(v_correct_discount, 0) + NEW.partner_discount_cup + v_shared_discount,
    v_fare_base
  );
  RETURN NEW;
END;
$function$;

-- El trigger debe despertarse también cuando cambian las DOS entradas del cálculo
-- nuevo. Hoy dropoff_location solo se escribe al crear el viaje, así que esto no
-- cambia nada; existe para que un cambio de destino en el futuro no deje un
-- descuento rancio que la plataforma terminaría subsidiando sin motivo.
DROP TRIGGER IF EXISTS rides_validate_promo_discount ON public.rides;
CREATE TRIGGER rides_validate_promo_discount
  BEFORE INSERT OR UPDATE OF promo_code_id, discount_amount_cup, shared_ride,
                             shared_ride_seats_occupied, dropoff_location,
                             corporate_account_id
  ON public.rides
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_rides_validate_promo_discount();

-- ─────────────────────────────────────────────────────────────────────
-- Solo-lectura, para que el pasajero vea el precio antes de confirmar.
-- La verdad la sigue escribiendo el trigger; esto es únicamente display.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_partner_discount_for_dropoff(
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_fare_cup INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_pt   GEOGRAPHY;
  v_row  RECORD;
  v_rate NUMERIC;
  v_disc INTEGER;
BEGIN
  IF auth.uid() IS NULL OR p_lat IS NULL OR p_lng IS NULL OR COALESCE(p_fare_cup, 0) <= 0 THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  v_pt := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

  SELECT pp.id, pp.name, pp.discount_percent
    INTO v_row
  FROM public.partner_places pp
  WHERE pp.is_active
    AND (pp.valid_until IS NULL OR pp.valid_until > now())
    AND ST_DWithin(pp.location, v_pt, pp.radius_m)
  ORDER BY ST_Distance(pp.location, v_pt)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- Mismo tope que aplica el trigger, para que lo mostrado coincida con lo cobrado.
  v_rate := get_platform_config_numeric('commission_rate', 0.15);
  IF v_rate IS NULL OR v_rate <= 0 OR v_rate >= 1 THEN
    v_rate := 0.15;
  END IF;

  v_disc := GREATEST(LEAST(
    ROUND(p_fare_cup * v_row.discount_percent / 100.0)::INTEGER,
    ROUND(p_fare_cup * v_rate)::INTEGER
  ), 0);

  RETURN jsonb_build_object(
    'found',            v_disc > 0,
    'place_id',         v_row.id,
    'place_name',       v_row.name,
    'discount_percent', v_row.discount_percent,
    'discount_cup',     v_disc
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_partner_discount_for_dropoff(DOUBLE PRECISION, DOUBLE PRECISION, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_partner_discount_for_dropoff(DOUBLE PRECISION, DOUBLE PRECISION, INTEGER)
  TO authenticated;

COMMENT ON FUNCTION public.get_partner_discount_for_dropoff(DOUBLE PRECISION, DOUBLE PRECISION, INTEGER) IS
  '00559 Solo display: qué descuento vería el pasajero al ir a este destino. El valor que se cobra lo escribe el trigger tg_rides_validate_promo_discount.';
