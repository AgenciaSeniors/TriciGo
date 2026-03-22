CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  segment_type TEXT NOT NULL, -- 'new_users', 'power_users', 'inactive', 'all', 'custom'
  segment_city_id UUID REFERENCES cities(id),
  message_title TEXT NOT NULL,
  message_body TEXT NOT NULL,
  promo_code_id UUID REFERENCES promotions(id),
  channel TEXT NOT NULL DEFAULT 'push', -- 'push', 'email', 'both'
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft', 'scheduled', 'sent', 'cancelled'
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  sent_count INTEGER DEFAULT 0,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admin full access on campaigns" ON campaigns
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
