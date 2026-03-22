CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ride_updates BOOLEAN NOT NULL DEFAULT true,
  chat_messages BOOLEAN NOT NULL DEFAULT true,
  promotions BOOLEAN NOT NULL DEFAULT true,
  payment_updates BOOLEAN NOT NULL DEFAULT true,
  driver_approval BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own preferences" ON notification_preferences
  FOR ALL USING (auth.uid() = user_id);

-- Auto-create preferences on first access
CREATE OR REPLACE FUNCTION ensure_notification_preferences(p_user_id UUID)
RETURNS notification_preferences AS $$
DECLARE
  result notification_preferences;
BEGIN
  INSERT INTO notification_preferences (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO result FROM notification_preferences WHERE user_id = p_user_id;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
