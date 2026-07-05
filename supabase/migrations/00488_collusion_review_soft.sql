-- 00488: Fase 2a del anti-colusión de cancelación — capa SEGURA (money-free).
--
-- Detecta cancelaciones POST-CONTACTO sospechosas (par conductor+pasajero que
-- cancela repetido tras el encuentro = posible colusión para evadir comisión
-- off-app), las encola en una tabla de revisión, y le da al admin sanciones
-- BLANDAS: descartar / aviso / reputación. NADA de dinero, suspensión ni baneo
-- (eso es Fase 2b, detrás de los ~14 fixes del red-team de seguridad).
--
-- Fixes del red-team incluidos: excluir cuentas demo/test (users.is_test);
-- incluir motivos exentos en la DETECCIÓN (solo excluyen de la penalización
-- automática, no de la auditoría) guardando el desglose; el UPSERT acumula
-- ride_ids y NO pisa casos ya tocados por un humano; no re-acusa pares
-- exonerados dentro de un cooldown; gate ata auth.uid()=admin_id.

-- ── a. Flag de cuentas demo/test (para excluirlas de la detección) ───────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

UPDATE users SET is_test = true
WHERE id IN (
    '00000000-0000-0000-0000-000000000001',  -- TriciGo Platform
    '00000000-0000-0000-0000-000000000099',
    'b2c3d4e5-f6a7-8901-bcde-f12345678901'   -- Admin TriciGo
  )
  OR phone IN ('+5355550100', '+5355550101');  -- María/Carlos demo (Play review)

-- ── b. Tunables (editables por admin sin redeploy) ──────────────────────────
INSERT INTO platform_config (key, value) VALUES
  ('collusion_pair_min_cancels', '2'),     -- ≥N cancelaciones post-contacto del par para encolar (agresivo)
  ('collusion_pair_window_days', '180'),   -- ventana de observación
  ('collusion_review_min_score', '40'),    -- score mínimo para entrar a la cola
  ('collusion_dismiss_cooldown_days', '30'),-- no re-acusar un par exonerado por N días
  ('collusion_rating_value', '1.0')        -- estrellas del evento de reputación por colusión
ON CONFLICT (key) DO NOTHING;

-- ── c. Tabla de casos de revisión (1 fila por par sospechoso) ───────────────
CREATE TABLE IF NOT EXISTS cancellation_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id    uuid NOT NULL REFERENCES driver_profiles(id) ON DELETE CASCADE,  -- el jugador repetido
  customer_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal_type  text NOT NULL DEFAULT 'repeated_pair'
                 CHECK (signal_type IN ('repeated_pair', 'driver_rate_anomaly', 'reported')),
  risk_score   numeric NOT NULL DEFAULT 0,
  signals      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- desglose auditable
  ride_ids     uuid[] NOT NULL DEFAULT '{}',         -- los rides del patrón
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'reviewed', 'dismissed', 'sanctioned')),
  verdict      text CHECK (verdict IN ('just', 'unjust')),
  sanction_type text CHECK (sanction_type IN ('warning', 'reputation')),  -- Fase 2b agregará suspension/commission_recovery/ban
  admin_notes  text,
  reviewed_by  uuid REFERENCES users(id),
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Un solo caso PENDIENTE vivo por par (el detector hace upsert-refresh; los
-- casos cerrados quedan como historia).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cancellation_reviews_pending_pair
  ON cancellation_reviews (driver_id, customer_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_cancellation_reviews_queue
  ON cancellation_reviews (status, risk_score DESC);
CREATE INDEX IF NOT EXISTS idx_cancellation_reviews_driver
  ON cancellation_reviews (driver_id);

ALTER TABLE cancellation_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cancellation_reviews_admin_all ON cancellation_reviews;
CREATE POLICY cancellation_reviews_admin_all ON cancellation_reviews
  FOR ALL USING (is_admin()) WITH CHECK (is_admin());

-- ── d. Detección: par repetido post-contacto → cola (money-free, solo lectura+insert) ──
CREATE OR REPLACE FUNCTION public.detect_collusion_reviews()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_window_days  integer := COALESCE(get_platform_config_numeric('collusion_pair_window_days', 180), 180)::integer;
  v_min_cancels  integer := COALESCE(get_platform_config_numeric('collusion_pair_min_cancels', 2), 2)::integer;
  v_min_score    numeric := COALESCE(get_platform_config_numeric('collusion_review_min_score', 40), 40);
  v_cooldown     integer := COALESCE(get_platform_config_numeric('collusion_dismiss_cooldown_days', 30), 30)::integer;
  v_exempt       text[] := ARRAY['no_show','passenger_gone','breakdown','safety','emergency'];
  v_count        integer := 0;
  v_score        numeric;
  rec            record;
BEGIN
  FOR rec IN
    SELECT p.customer_id, p.driver_id,
           count(*)                                                          AS pair_cancel_count,
           count(*) FILTER (WHERE p.rc IS NULL OR NOT (p.rc = ANY(v_exempt))) AS nonexempt_count,
           count(*) FILTER (WHERE p.rc = ANY(v_exempt))                       AS exempt_count,
           array_agg(p.ride_id)                                              AS ride_ids
    FROM (
      SELECT r.customer_id, r.driver_id, r.id AS ride_id, r.cancellation_reason_code AS rc
      FROM rides r
      JOIN driver_profiles dp ON dp.id = r.driver_id
      JOIN users du ON du.id = dp.user_id
      JOIN users cu ON cu.id = r.customer_id
      WHERE r.status = 'canceled'
        AND r.driver_id IS NOT NULL AND r.customer_id IS NOT NULL
        AND r.driver_arrived_at IS NOT NULL                                  -- post-contacto
        AND r.canceled_at > now() - (v_window_days || ' days')::interval
        AND du.is_test = false AND cu.is_test = false                        -- excluir demo/test
    ) p
    GROUP BY p.customer_id, p.driver_id
    HAVING count(*) >= v_min_cancels
  LOOP
    -- Skip si el par fue exonerado hace poco (no re-acusar).
    IF EXISTS (
      SELECT 1 FROM cancellation_reviews cr
      WHERE cr.driver_id = rec.driver_id AND cr.customer_id = rec.customer_id
        AND cr.status = 'dismissed'
        AND cr.reviewed_at > now() - (v_cooldown || ' days')::interval
    ) THEN
      CONTINUE;
    END IF;

    -- Score: base por par; los no-exentos pesan más (los exentos suman menos
    -- porque el motivo es client-set y puede ser el "botón de invisibilidad").
    v_score := LEAST(100, 40 + 20 * (rec.nonexempt_count - 1) + 5 * rec.exempt_count);
    IF v_score < v_min_score THEN CONTINUE; END IF;

    INSERT INTO cancellation_reviews (driver_id, customer_id, signal_type, risk_score, signals, ride_ids, status)
    VALUES (
      rec.driver_id, rec.customer_id, 'repeated_pair', v_score,
      jsonb_build_object(
        'pair_cancel_count', rec.pair_cancel_count,
        'nonexempt_count', rec.nonexempt_count,
        'exempt_count', rec.exempt_count,
        'window_days', v_window_days
      ),
      rec.ride_ids, 'pending'
    )
    ON CONFLICT (driver_id, customer_id) WHERE status = 'pending'
    DO UPDATE SET
      risk_score  = EXCLUDED.risk_score,
      signals     = EXCLUDED.signals,
      signal_type = EXCLUDED.signal_type,
      ride_ids    = (SELECT array_agg(DISTINCT e) FROM unnest(cancellation_reviews.ride_ids || EXCLUDED.ride_ids) e),
      updated_at  = now();
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

-- ── e. Sanción BLANDA (dismiss / warning / reputation) — money-free ─────────
CREATE OR REPLACE FUNCTION public.apply_collusion_sanction(
  p_review_id uuid,
  p_level     text,
  p_notes     text,
  p_admin_id  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_review       cancellation_reviews%ROWTYPE;
  v_driver_user  uuid;
  v_rating_value numeric := COALESCE(get_platform_config_numeric('collusion_rating_value', 1.0), 1.0);
BEGIN
  -- Gate de dos capas: ata la acción al caller (admin_actions es regulatorio).
  IF auth.uid() IS NULL OR auth.uid() <> p_admin_id THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF NOT is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  -- Fase 2a: SOLO sanciones blandas. money/suspensión/baneo son Fase 2b.
  IF p_level NOT IN ('dismiss', 'warning', 'reputation') THEN
    RETURN jsonb_build_object('error', 'invalid_level');
  END IF;

  SELECT * INTO v_review FROM cancellation_reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'review_not_found');
  END IF;
  IF v_review.status IN ('sanctioned', 'dismissed') THEN
    RETURN jsonb_build_object('error', 'already_resolved', 'status', v_review.status);
  END IF;

  SELECT user_id INTO v_driver_user FROM driver_profiles WHERE id = v_review.driver_id;

  IF p_level = 'dismiss' THEN
    UPDATE cancellation_reviews SET
      status = 'dismissed', verdict = 'just', sanction_type = NULL,
      admin_notes = p_notes, reviewed_by = p_admin_id, reviewed_at = now(), updated_at = now()
    WHERE id = p_review_id;
  ELSE
    -- 'warning' o 'reputation' → veredicto 'unjust', caso sancionado.
    IF p_level = 'reputation' AND v_driver_user IS NOT NULL THEN
      -- Evento de reputación (ride_id NULL → no choca con el unique parcial de
      -- eventos por-ride). El trigger tg_cancellation_rating_event_apply (00372)
      -- recomputa rating_avg → menos prioridad de matching. CERO dinero.
      INSERT INTO cancellation_rating_events (user_id, ride_id, rating_value, role_at_event, reason)
      VALUES (v_driver_user, NULL, v_rating_value, 'driver', 'collusion:' || p_review_id::text);
    END IF;
    UPDATE cancellation_reviews SET
      status = 'sanctioned', verdict = 'unjust', sanction_type = p_level,
      admin_notes = p_notes, reviewed_by = p_admin_id, reviewed_at = now(), updated_at = now()
    WHERE id = p_review_id;
  END IF;

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, new_values, reason)
  VALUES (
    p_admin_id, 'collusion_' || p_level, 'cancellation_review', p_review_id::text,
    jsonb_build_object('driver_id', v_review.driver_id, 'customer_id', v_review.customer_id,
                       'risk_score', v_review.risk_score, 'ride_ids', v_review.ride_ids),
    p_notes
  );

  RETURN jsonb_build_object('success', true, 'level', p_level, 'driver_user_id', v_driver_user);
END;
$function$;

-- ── f. Reversión de una sanción blanda (apelación) ──────────────────────────
CREATE OR REPLACE FUNCTION public.reverse_collusion_sanction(
  p_review_id uuid,
  p_admin_id  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_review      cancellation_reviews%ROWTYPE;
  v_driver_user uuid;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_admin_id OR NOT is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  SELECT * INTO v_review FROM cancellation_reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'review_not_found'); END IF;
  IF v_review.status <> 'sanctioned' THEN
    RETURN jsonb_build_object('error', 'not_sanctioned', 'status', v_review.status);
  END IF;

  SELECT user_id INTO v_driver_user FROM driver_profiles WHERE id = v_review.driver_id;
  -- Quitar el evento de reputación (el trigger recomputa rating_avg → restaura).
  DELETE FROM cancellation_rating_events
  WHERE user_id = v_driver_user AND ride_id IS NULL
    AND reason = 'collusion:' || p_review_id::text;

  UPDATE cancellation_reviews SET
    status = 'reviewed', verdict = 'just', sanction_type = NULL,
    reviewed_by = p_admin_id, reviewed_at = now(), updated_at = now()
  WHERE id = p_review_id;

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (p_admin_id, 'collusion_reversed', 'cancellation_review', p_review_id::text, 'reversed on appeal');

  RETURN jsonb_build_object('success', true);
END;
$function$;

-- ── g. Grants ────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.detect_collusion_reviews()                    FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.apply_collusion_sanction(uuid, text, text, uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.reverse_collusion_sanction(uuid, uuid)         FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.detect_collusion_reviews()                    TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.apply_collusion_sanction(uuid, text, text, uuid) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.reverse_collusion_sanction(uuid, uuid)         TO authenticated;
