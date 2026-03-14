-- ============================================================================
-- Migration 00040: In-App Notification Center
-- ============================================================================
-- Persistent per-user notification inbox. Every push notification sent via
-- the send-push edge function is also stored here so users can browse
-- their notification history, see unread counts, and deep-link to
-- relevant screens.
-- ============================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data JSONB DEFAULT NULL,
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary inbox query: user's notifications ordered by newest, filterable by read status
CREATE INDEX idx_notifications_user_inbox
  ON notifications(user_id, read, created_at DESC);

-- Fast unread count
CREATE INDEX idx_notifications_user_unread
  ON notifications(user_id) WHERE read = false;

-- Cleanup of old notifications
CREATE INDEX idx_notifications_cleanup
  ON notifications(created_at);

-- ============================================================
-- RLS Policies
-- ============================================================
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Users can read their own notifications; admins can read all
CREATE POLICY "notification_select" ON notifications FOR SELECT USING (
  user_id = auth.uid() OR is_admin()
);

-- Users can mark their own notifications as read; admins can update any
CREATE POLICY "notification_update" ON notifications FOR UPDATE USING (
  user_id = auth.uid() OR is_admin()
);

-- Only service role / admin can insert notifications (via edge functions or triggers)
CREATE POLICY "notification_insert" ON notifications FOR INSERT WITH CHECK (
  is_admin()
);

-- ============================================================
-- Cleanup function (removes notifications older than 90 days)
-- ============================================================
CREATE OR REPLACE FUNCTION cleanup_old_notifications()
RETURNS void
LANGUAGE sql SECURITY DEFINER
AS $$
  DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '90 days';
$$;

-- ============================================================
-- Enable Realtime for live inbox updates
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;

-- ============================================================
-- Feature flag
-- ============================================================
INSERT INTO feature_flags (key, value, description) VALUES
  ('notification_center_enabled', false, 'Habilitar centro de notificaciones in-app')
ON CONFLICT (key) DO NOTHING;
