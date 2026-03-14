export type LostItemStatus =
  | 'reported'
  | 'driver_notified'
  | 'found'
  | 'not_found'
  | 'return_arranged'
  | 'returned'
  | 'closed';

export type LostItemCategory =
  | 'phone'
  | 'wallet'
  | 'bag'
  | 'clothing'
  | 'electronics'
  | 'documents'
  | 'keys'
  | 'other';

export interface LostItem {
  id: string;
  ride_id: string;
  reporter_id: string;
  driver_id: string;
  description: string;
  category: LostItemCategory;
  photo_urls: string[];
  status: LostItemStatus;
  driver_response: string | null;
  driver_found: boolean | null;
  return_fee_cup: number | null;
  return_location: string | null;
  return_notes: string | null;
  admin_notes: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}
