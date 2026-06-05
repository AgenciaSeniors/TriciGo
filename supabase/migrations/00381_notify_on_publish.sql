-- ============================================================
-- 00381_notify_on_publish.sql
--
-- Fase 2 del plan de notificaciones de contenido. Agrega el opt-in
-- "notificar al publicar" + un marcador de idempotencia a los dos
-- tipos de contenido del admin que ya tienen botón "Notificar ahora".
--
--   notify_on_publish  el admin quiere un push automático al
--                      activar/publicar (default true; editable en el form).
--   notified_at        cuándo se envió el push (NULL = todavía no).
--                      Garantiza "una sola vez": el auto-push solo dispara
--                      si notified_at IS NULL. El botón manual "Notificar
--                      ahora" reenvía siempre y re-sella notified_at.
--
-- Backfill defensivo: el contenido YA activo/publicado se marca como
-- notified_at = now() para que aplicar esta migración NO dispare un push
-- retroactivo la próxima vez que se edite/togglee.
--
-- blog_posts se creó fuera de git (en el proyecto remoto); por eso usamos
-- ADD COLUMN IF NOT EXISTS (idempotente y tolerante a su origen).
-- ============================================================

ALTER TABLE home_announcements
  ADD COLUMN IF NOT EXISTS notify_on_publish BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

ALTER TABLE blog_posts
  ADD COLUMN IF NOT EXISTS notify_on_publish BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

-- Don't retro-notify content that is already live.
UPDATE home_announcements SET notified_at = now()
  WHERE is_active = true AND notified_at IS NULL;

UPDATE blog_posts SET notified_at = now()
  WHERE is_published = true AND notified_at IS NULL;
