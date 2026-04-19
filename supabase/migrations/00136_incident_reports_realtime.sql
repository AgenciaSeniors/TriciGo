-- ============================================================
-- Migration 00136: Enable Realtime on incident_reports (I2)
--
-- The admin dashboard's SOS banner subscribes to INSERT/UPDATE events
-- on public.incident_reports via postgres_changes. Without the table
-- being in the supabase_realtime publication those events never reach
-- the WebSocket, so the banner would only update on page reload.
--
-- Adding the table to the publication is idempotent via a DO block.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'incident_reports'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.incident_reports';
  END IF;
END $$;
