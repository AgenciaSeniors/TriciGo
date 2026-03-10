// ============================================================
// TriciGo — Support Ticket Types
// ============================================================

export type TicketStatus = 'open' | 'in_progress' | 'waiting_user' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TicketCategory =
  | 'ride_issue'
  | 'payment_issue'
  | 'driver_complaint'
  | 'passenger_complaint'
  | 'account_issue'
  | 'app_bug'
  | 'feature_request'
  | 'other';

export interface SupportTicket {
  id: string;
  user_id: string;
  ride_id: string | null;
  category: TicketCategory;
  subject: string;
  description: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  assigned_to: string | null;
  created_at: string;
  updated_at: string | null;
  resolved_at: string | null;
}

export interface TicketMessage {
  id: string;
  ticket_id: string;
  sender_id: string;
  message: string;
  is_admin: boolean;
  created_at: string;
}

export interface DeliveryDetails {
  id: string;
  ride_id: string;
  pickup_description: string | null;
  dropoff_description: string | null;
  package_type: string | null;
  estimated_weight: string | null;
  recipient_phone: string | null;
  recipient_name: string | null;
  delivery_photo_url: string | null;
  notes: string | null;
  created_at: string;
}
