-- ============================================================
-- Migration 00014: Support Tickets + Mensajeria (Delivery)
-- Adds support ticket system and delivery details for rides.
-- ============================================================

-- Support tickets
CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  ride_id UUID REFERENCES rides(id),
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT DEFAULT 'normal',
  assigned_to UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user
  ON support_tickets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status
  ON support_tickets(status, created_at DESC);

-- Ticket messages
CREATE TABLE IF NOT EXISTS ticket_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  is_admin BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket
  ON ticket_messages(ticket_id, created_at ASC);

-- RLS for support tickets
ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own tickets" ON support_tickets;
CREATE POLICY "Users read own tickets" ON support_tickets
  FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "Users create own tickets" ON support_tickets;
CREATE POLICY "Users create own tickets" ON support_tickets
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Admins update tickets" ON support_tickets;
CREATE POLICY "Admins update tickets" ON support_tickets
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'super_admin')
    )
  );

-- RLS for ticket messages
ALTER TABLE ticket_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Ticket participants read messages" ON ticket_messages;
CREATE POLICY "Ticket participants read messages" ON ticket_messages
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM support_tickets
      WHERE support_tickets.id = ticket_id
        AND (support_tickets.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'super_admin')
          ))
    )
  );

DROP POLICY IF EXISTS "Ticket participants insert messages" ON ticket_messages;
CREATE POLICY "Ticket participants insert messages" ON ticket_messages
  FOR INSERT
  WITH CHECK (
    sender_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM support_tickets
      WHERE support_tickets.id = ticket_id
        AND (support_tickets.user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'super_admin')
          ))
    )
  );

-- Delivery details (for mensajeria/package delivery rides)
CREATE TABLE IF NOT EXISTS delivery_details (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id UUID NOT NULL REFERENCES rides(id) UNIQUE,
  pickup_description TEXT,
  dropoff_description TEXT,
  package_type TEXT,
  estimated_weight TEXT,
  recipient_phone TEXT,
  recipient_name TEXT,
  delivery_photo_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE delivery_details ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Ride participants read delivery" ON delivery_details;
CREATE POLICY "Ride participants read delivery" ON delivery_details
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rides
      WHERE rides.id = ride_id
        AND (rides.customer_id = auth.uid() OR rides.driver_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'super_admin')
          ))
    )
  );

DROP POLICY IF EXISTS "Customers create delivery details" ON delivery_details;
CREATE POLICY "Customers create delivery details" ON delivery_details
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM rides
      WHERE rides.id = ride_id AND rides.customer_id = auth.uid()
    )
  );

-- Add service_type for mensajeria
-- (The 'mensajeria' service type can be added via admin settings UI)
