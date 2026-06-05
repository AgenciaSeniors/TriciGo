-- ============================================================
-- 00382_promotions_notify.sql
--
-- Fase 3 del plan de notificaciones de contenido. Da a `promotions`
-- (hasta ahora solo códigos de descuento, sin pantalla admin) el copy
-- de marketing + el opt-in de push "notificar al publicar", para que la
-- nueva pantalla admin pueda crear/activar una promo y avisar a todos.
--
--   title_es / body_es / image_url   copy mostrado + usado en el push
--   notify_on_publish                opt-in (default true)
--   notified_at                      idempotencia (NULL = no enviado)
--
-- Backfill defensivo: las promos YA activas se marcan notificadas para
-- no disparar un push retroactivo al aplicar esta migración.
-- ============================================================

ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS title_es TEXT,
  ADD COLUMN IF NOT EXISTS body_es TEXT,
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS notify_on_publish BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

UPDATE promotions SET notified_at = now()
  WHERE is_active = true AND notified_at IS NULL;
