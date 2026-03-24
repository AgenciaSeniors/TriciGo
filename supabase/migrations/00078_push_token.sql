-- Add push token column for expo push notifications
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS push_token text;
