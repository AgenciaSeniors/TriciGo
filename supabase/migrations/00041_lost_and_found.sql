-- ============================================================
-- Migration 00041: Lost & Found System
-- ============================================================

-- 1. Create lost_items table
CREATE TABLE IF NOT EXISTS lost_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id UUID NOT NULL REFERENCES rides(id),
  reporter_id UUID NOT NULL REFERENCES auth.users(id),
  driver_id UUID NOT NULL REFERENCES auth.users(id),
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  photo_urls TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'reported',
  driver_response TEXT,
  driver_found BOOLEAN,
  return_fee_cup INTEGER,
  return_location TEXT,
  return_notes TEXT,
  admin_notes TEXT,
  resolved_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,

  CONSTRAINT chk_lost_item_status CHECK (
    status IN ('reported','driver_notified','found','not_found','return_arranged','returned','closed')
  ),
  CONSTRAINT chk_lost_item_category CHECK (
    category IN ('phone','wallet','bag','clothing','electronics','documents','keys','other')
  )
);

-- Partial unique: only one active lost item per ride
CREATE UNIQUE INDEX idx_lost_items_active_per_ride
  ON lost_items(ride_id)
  WHERE status NOT IN ('returned','closed');

-- 2. Indexes
CREATE INDEX idx_lost_items_ride ON lost_items(ride_id);
CREATE INDEX idx_lost_items_reporter ON lost_items(reporter_id, created_at DESC);
CREATE INDEX idx_lost_items_driver ON lost_items(driver_id, status);
CREATE INDEX idx_lost_items_status ON lost_items(status);

-- 3. Auto-update updated_at trigger (reuse existing function)
CREATE TRIGGER trg_lost_items_updated_at
  BEFORE UPDATE ON lost_items
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 4. RLS
ALTER TABLE lost_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY lost_items_select ON lost_items
  FOR SELECT USING (
    reporter_id = auth.uid()
    OR driver_id = auth.uid()
    OR is_admin()
  );

CREATE POLICY lost_items_insert ON lost_items
  FOR INSERT WITH CHECK (
    reporter_id = auth.uid()
  );

CREATE POLICY lost_items_update ON lost_items
  FOR UPDATE USING (
    reporter_id = auth.uid()
    OR driver_id = auth.uid()
    OR is_admin()
  );

-- 5. Notification trigger for lost item status changes
CREATE OR REPLACE FUNCTION notify_lost_item_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Notify driver when item reported
  IF TG_OP = 'INSERT' THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwODQ1NiwiZXhwIjoyMDg4NTg0NDU2fQ.-fBsXIjuuUFW-8FXf8Kq9nA-ZNBli_vk3wcChSf6WzQ"}'::jsonb,
      body := jsonb_build_object(
        'user_id', NEW.driver_id::text,
        'title', 'Objeto perdido reportado',
        'body', 'Un pasajero reportó un objeto perdido en tu último viaje',
        'data', jsonb_build_object('route', '/trip/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'system'
      )
    );
    RETURN NEW;
  END IF;

  -- Notify rider when driver responds (found or not found)
  IF NEW.driver_found IS NOT NULL AND (OLD.driver_found IS NULL) THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwODQ1NiwiZXhwIjoyMDg4NTg0NDU2fQ.-fBsXIjuuUFW-8FXf8Kq9nA-ZNBli_vk3wcChSf6WzQ"}'::jsonb,
      body := jsonb_build_object(
        'user_id', NEW.reporter_id::text,
        'title', CASE WHEN NEW.driver_found THEN 'Objeto encontrado' ELSE 'Objeto no encontrado' END,
        'body', CASE WHEN NEW.driver_found THEN 'El conductor encontró tu objeto. Se coordinará la devolución.' ELSE 'El conductor no encontró el objeto en el vehículo.' END,
        'data', jsonb_build_object('route', '/ride/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'system'
      )
    );
  END IF;

  -- Notify rider when return arranged
  IF NEW.status = 'return_arranged' AND OLD.status != 'return_arranged' THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwODQ1NiwiZXhwIjoyMDg4NTg0NDU2fQ.-fBsXIjuuUFW-8FXf8Kq9nA-ZNBli_vk3wcChSf6WzQ"}'::jsonb,
      body := jsonb_build_object(
        'user_id', NEW.reporter_id::text,
        'title', 'Devolución coordinada',
        'body', 'Se ha coordinado la devolución de tu objeto',
        'data', jsonb_build_object('route', '/ride/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'system'
      )
    );
  END IF;

  -- Notify rider when item returned
  IF NEW.status = 'returned' AND OLD.status != 'returned' THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwODQ1NiwiZXhwIjoyMDg4NTg0NDU2fQ.-fBsXIjuuUFW-8FXf8Kq9nA-ZNBli_vk3wcChSf6WzQ"}'::jsonb,
      body := jsonb_build_object(
        'user_id', NEW.reporter_id::text,
        'title', 'Objeto devuelto',
        'body', 'Tu objeto ha sido devuelto exitosamente',
        'data', jsonb_build_object('route', '/ride/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'system'
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_lost_item_notifications
  AFTER INSERT OR UPDATE ON lost_items
  FOR EACH ROW
  EXECUTE FUNCTION notify_lost_item_change();

-- 6. Feature flag
INSERT INTO feature_flags (key, value, description)
VALUES ('lost_and_found_enabled', false, 'Habilitar sistema de objetos perdidos / Lost & Found')
ON CONFLICT (key) DO NOTHING;
