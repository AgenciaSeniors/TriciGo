-- 00543_fix_driver_role_promotion.sql
--
-- Bug: al aprobar un conductor, ensure_driver_role_and_tricicoin_on_approval hace
-- `UPDATE users SET role='driver'`, pero el BEFORE UPDATE tg_users_protect_admin_fields
-- (00291, anti-escalada) lo revierte en su rama `IF is_admin() THEN NEW.role := OLD.role`.
-- Como auth.uid() durante el trigger es el ADMIN aprobador (no super_admin), la promoción
-- se pisa. Resultado medido en prod (2026-08-04): 80 de 84 conductores aprobados quedaron
-- con users.role='customer'. Consecuencias: _gift_wallet_type enruta sus referidos a
-- customer_cash en vez de tricicoin; el bono de fundador (tricicoin) queda mal asociado al
-- rol; y se dispararon re-pagos manuales.
--
-- Fix: carve-out quirúrgico en la rama is_admin() — permitir SOLO la promoción legítima
-- customer->driver cuando el usuario YA tiene un driver_profiles aprobado. Todo lo demás
-- (escalar a admin/super_admin, cambiar level, etc.) sigue protegido exactamente igual.
-- Cubre el trigger de sistema durante la aprobación (actor admin; el driver_profiles ya
-- está 'approved' porque ensure_driver_role es AFTER) y una promoción manual de admin de
-- un conductor ya aprobado.
--
-- Cuerpo transcrito verbatim de pg_get_functiondef (prod: md5 e86c2ba5cd8a7a256cd85cf1bf03fe53,
-- length 1489). Único cambio: el bloque `NEW.role := OLD.role;` de la rama is_admin().

CREATE OR REPLACE FUNCTION public.tg_users_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_super_admin() THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.trusted_tier_update', true) = '1' THEN
    NEW.role                 := OLD.role;
    NEW.is_active            := OLD.is_active;
    NEW.total_spent          := OLD.total_spent;
    NEW.cancellation_count   := OLD.cancellation_count;
    NEW.last_cancellation_at := OLD.last_cancellation_at;
    NEW.id                   := OLD.id;
    NEW.created_at           := OLD.created_at;
    RETURN NEW;
  END IF;

  IF current_setting('app.trusted_cancel_update', true) = '1' THEN
    NEW.role        := OLD.role;
    NEW.is_active   := OLD.is_active;
    NEW.level       := OLD.level;
    NEW.total_rides := OLD.total_rides;
    NEW.total_spent := OLD.total_spent;
    NEW.id          := OLD.id;
    NEW.created_at  := OLD.created_at;
    RETURN NEW;
  END IF;

  IF is_admin() THEN
    -- 00543: permitir SOLO la promoción legítima de un conductor ya aprobado.
    -- Cualquier otro cambio de rol se revierte igual que antes (deny-by-default).
    IF NOT (OLD.role = 'customer' AND NEW.role = 'driver'
            AND EXISTS (SELECT 1 FROM driver_profiles dp
                        WHERE dp.user_id = NEW.id AND dp.status = 'approved')) THEN
      NEW.role := OLD.role;
    END IF;
    NEW.level := OLD.level;
    NEW.id          := OLD.id;
    NEW.created_at  := OLD.created_at;
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.role               := OLD.role;
  NEW.is_active          := OLD.is_active;
  NEW.level              := OLD.level;
  NEW.total_rides        := OLD.total_rides;
  NEW.total_spent        := OLD.total_spent;
  NEW.cancellation_count := OLD.cancellation_count;
  NEW.last_cancellation_at := OLD.last_cancellation_at;
  NEW.id                 := OLD.id;
  NEW.created_at         := OLD.created_at;

  RETURN NEW;
END;
$function$;
